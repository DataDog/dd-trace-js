'use strict'

const log = require('../log')
const { WasmSpanState, wasmMemory } = require('./index')

// A queued op (or an extracted chunk) referenced a span id that is absent from
// native storage. The wasm error may arrive as an Error or a bare string.
function isSpanNotFoundError (e) {
  return /span not found/.test(String(e != null && e.message != null ? e.message : e))
}

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024 // 8MB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB

// OpCode values are small u32 integers, written as u64 LE via two u32 writes.

/**
 * NativeSpansInterface provides the JavaScript bridge to the native span storage.
 *
 * It manages:
 * - Shared buffers for efficient data transfer to/from Rust
 * - The change buffer protocol for queuing span operations
 * - The string table for string deduplication
 * - Span export to the Datadog agent
 *
 * ## Detach-safety invariant
 *
 * The cached `_cqbView` / `_cqbBytes` views into WASM memory get detached
 * whenever a WASM call grows memory. Two things keep them fresh:
 *
 * 1. Every change-buffer write method (`queueOp`, `queueCreateSpan`,
 *    `queueBatchMeta`, `queueBatchMetrics`) calls `#checkDetach()` at entry.
 *    This catches growth from a *prior* call that did not itself refresh —
 *    notably the async `flushStats` interval, which runs between spans. It is
 *    also necessary because a queue method may make no growing wasm call of
 *    its own (e.g. a `queueCreateSpan` whose name is already interned, so
 *    `getStringId` is a cache hit) and would otherwise never refresh a view
 *    detached earlier.
 *
 * 2. Growth *during* a method is handled at the call site: `stringTableInsertOne`
 *    (in `getStringId`), `flushChangeQueue`, and `prepareChunk` (in `flushSpans`)
 *    are each followed by `#checkDetach()`. Since all `getStringId` resolution
 *    runs **before** the local `view`/`buf` snapshots are taken, those locals
 *    always see a fresh view.
 *
 * ## Change-buffer wire format
 *
 * The change buffer is a contiguous WASM-memory region whose layout is:
 *
 *   header   : [count: u64 LE]                    @ offset 0
 *   per op   : [opcode: u16 LE][spanId: u64 LE][...payload...]
 *
 * Spans are addressed by their span_id (the 8-byte LE handle), not a slot.
 * Each `queue*` method appends one op record and increments `count`.
 *
 * ### Generic queueOp args
 *
 * `queueOp(op, spanId, ...args)` writes per-arg encodings after the header:
 *       number              → u32 string-id (pre-resolved)
 *       ['id64', value]     → u64 LE (8 bytes; byte-swapped from BE Identifier)
 *       ['id128', value]    → u128 LE (16 bytes; byte-swapped from BE Identifier;
 *                                      8-byte inputs are zero-padded to 16)
 *       ['ns', ms]          → u64 LE nanoseconds (ms * 1e6, rounded)
 *       ['i32', value]      → i32 LE
 *       ['f64', value]      → f64 LE
 *
 * ### Method-specific record layouts
 *
 *   queueCreateSpan (op=13):     [traceId u128 LE][segmentId u64 LE]
 *                                [parentId u64 LE][nameId u32][start i64 LE]
 *   queueBatchMeta (op=15):      [count: u32][keyId u32, valId u32] × count
 *   queueBatchMetrics (op=16):   [count: u32][keyId u32, value f64] × count
 *
 * (spanId is in the op header above; segmentId groups one local trace.)
 *
 * All u64 fields use the LE representation in WASM memory; spanId/traceId/
 * parentId payloads byte-swap from the JS-side BE Identifier buffers.
 */

/**
 * Normalize an agent URL for the native (libdatadog) layer.
 *
 * dd-trace-js represents a Windows named pipe as `unix://./pipe/...` (protocol
 * `unix:`, hostname `.`), matching the legacy agent exporter. libdatadog's
 * ddcommon `parse_uri` instead expects the `windows:` scheme for pipes, where
 * everything after `windows:` is the path. Rewriting the scheme makes the
 * socket path decode to the same `//./pipe/...` value the legacy exporter
 * hands to Node's `socketPath`. Plain Unix domain sockets (`unix:///path`)
 * and http(s) URLs are already understood by `parse_uri` and pass through
 * unchanged.
 *
 * @param {string} url Agent URL
 * @returns {string} URL in the form libdatadog's `parse_uri` expects
 */
function normalizeAgentUrl (url) {
  if (typeof url === 'string' && url.startsWith('unix://./')) {
    return 'windows:' + url.slice('unix:'.length)
  }
  return url
}

class NativeSpansInterface {
  /**
   * @param {object} options Configuration options
   * @param {string} options.agentUrl URL of the Datadog agent
   * @param {string} options.tracerVersion Version of dd-trace
   * @param {string} [options.lang] Language identifier (defaults to 'nodejs')
   * @param {string} [options.langVersion] Language version (defaults to process.version)
   * @param {string} [options.langInterpreter] Language interpreter (defaults to 'v8')
   * @param {number} [options.pid] Process ID (defaults to process.pid)
   * @param {string} options.tracerService Default service name
   * @param {boolean} [options.statsEnabled] Enable native stats collection (defaults to false)
   * @param {string} [options.hostname] Hostname for stats payload (defaults to '')
   * @param {string} [options.env] Environment for stats payload (defaults to '')
   * @param {string} [options.appVersion] App version for stats payload (defaults to '')
   * @param {string} [options.runtimeId] Runtime ID for stats payload (defaults to '')
   * @param {boolean} [options.clientComputedStats] Send the Datadog-Client-Computed-Stats
   *   header so the agent skips its own APM stats/sampling (defaults to false)
   */
  constructor (options) {
    if (!WasmSpanState) {
      throw new Error('Native spans module is not available')
    }

    // Store options for potential re-initialization
    this._options = {
      tracerVersion: options.tracerVersion,
      lang: options.lang || 'nodejs',
      langVersion: options.langVersion || process.version,
      langInterpreter: options.langInterpreter || 'v8',
      pid: options.pid ?? process.pid,
      tracerService: options.tracerService,
      statsEnabled: options.statsEnabled || false,
      hostname: options.hostname || '',
      env: options.env || '',
      appVersion: options.appVersion || '',
      runtimeId: options.runtimeId || '',
      clientComputedStats: options.clientComputedStats || false,
    }

    // When DD_TRACE_OTEL_SEMANTICS_ENABLED is set, the span context holds the
    // Datadog HTTP tags out of the WASM store and syncs the OTel-named ones at
    // finish (WASM has no remove-meta op, so eagerly-synced DD keys couldn't be
    // dropped). Read on the hot tag-sync path, so keep it a plain field.
    this.otelSemanticsEnabled = options.otelSemanticsEnabled || false

    // Flush buffer for span export
    this._flushBuffer = Buffer.alloc(FLUSH_BUFFER_SIZE)

    // Change queue buffer state
    // First 8 bytes store the count of operations
    this._cqbIndex = 8
    this._cqbCount = 0

    // Segment allocator state. Spans are addressed by their span_id; a
    // `segment_id` groups spans of one local trace so trace-level state and
    // chunk flushing stay isolated. One id per local trace, shared by all its
    // spans (stored on the shared `_trace` object by span.js).
    this._nextSegment = 0

    // String table state
    this._stringMap = new Map()
    this._stringIdCounter = 0

    // Initialize the WASM state (buffers are allocated in WASM memory)
    // Tracks whether v0.5 output has been negotiated, so it survives a
    // setAgentUrl() that rebuilds the WASM state (which would otherwise reset
    // to the v0.4 default).
    this._useV05 = false
    // OTLP export config (set when OTEL_TRACES_EXPORTER=otlp). Persisted so it
    // survives a setAgentUrl() rebuild, like _useV05. When _otlpEndpoint is
    // set, libdatadog exports traces via OTLP instead of to the agent.
    this._otlpEndpoint = null
    this._otlpProtocol = null
    this._otlpHeaders = null
    this._state = this.#createWasmState(options.agentUrl)

    // Get the WASM memory views for writing to the change queue buffer
    this._wasmMemory = wasmMemory
    this._cqbPtr = this._state.change_queue_ptr()
    this.#refreshViews()

    // Start stats flush interval if stats are enabled
    if (this._options.statsEnabled) {
      this._statsInterval = setInterval(() => {
        this._state.flushStats(false).catch((err) => {
          log.error('Error flushing native stats:', err)
        })
      }, 10_000)
      this._statsInterval.unref?.()

      // Force flush stats on process exit. Failure here loses buffered stats —
      // we cannot retry past beforeExit, but we must surface the cause.
      const handler = () => {
        this._state.flushStats(true).catch((err) => {
          log.warn('Failed final native stats flush on exit:', err)
        })
      }
      const handlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
      if (handlers) {
        handlers.add(handler)
      } else {
        // Fallback path covers test/synthetic setups that bypass dd-trace's
        // entry point. In production the shared registry is always present.
        process.once('beforeExit', handler)
      }
    }

    log.debug('Native spans interface initialized')
  }

  /**
   * Select v0.5 output on the native exporter. Must be called before the first
   * flush (the WASM exporter fixes its output format at first send). v0.5
   * silently drops meta_struct/top-level span_events — callers must only enable
   * it after confirming the agent advertises /v0.5/traces.
   * @param {boolean} useV05
   */
  setUseV05 (useV05) {
    this._useV05 = useV05
    this._state.setUseV05(useV05)
  }

  /**
   * Route trace export through libdatadog's OTLP HTTP exporter instead of the
   * Datadog agent. Must be set before the first flush.
   * @param {string} url OTLP HTTP traces endpoint (e.g. http://host:4318/v1/traces)
   */
  setOtlpEndpoint (url) {
    // Forward first, persist only on success (matching setOtlpProtocol), so a
    // value the native layer rejects is never re-applied on a setAgentUrl rebuild.
    this._state.setOtlpEndpoint(url)
    this._otlpEndpoint = url
  }

  /**
   * Select the OTLP wire protocol ('http/json' or 'http/protobuf'). Throws on
   * unsupported values (e.g. 'grpc'); callers should guard.
   * @param {string} protocol
   */
  setOtlpProtocol (protocol) {
    // Forward first: only persist a protocol the native layer accepts, so a
    // later setAgentUrl() rebuild never re-applies an invalid value.
    this._state.setOtlpProtocol(protocol)
    this._otlpProtocol = protocol
  }

  /**
   * Set extra OTLP export headers (e.g. collector auth).
   * @param {string[]} headers Flat [key, value, ...] pairs
   */
  setOtlpHeaders (headers) {
    // Forward first, persist only on success (see setOtlpEndpoint).
    this._state.setOtlpHeaders(headers)
    this._otlpHeaders = headers
  }

  /**
   * Update the agent URL by reinitializing the native state.
   * Warning: This will discard any buffered but unflushed span data.
   * @param {string} url New agent URL
   */
  setAgentUrl (url) {
    // Flush any pending operations to the OLD state first.
    this.flushChangeQueue()

    // Build the new state BEFORE clearing JS-side bookkeeping. If the WASM
    // constructor throws (OOM, invalid URL, libdatadog init failure), the
    // existing state remains consistent: `_state`, `_stringMap`, and
    // `_stringIdCounter` continue to agree, so subsequent `getStringId`
    // calls don't collide with already-interned ids in the old WASM table.
    const newState = this.#createWasmState(url)
    // Preserve a previously-negotiated v0.5 selection across the rebuild
    // (the format must be set before the new state's first send). NOTE: this
    // assumes the new agent also supports v0.5 — we do not re-run /info
    // negotiation here. setAgentUrl is rare and v0.5 is an explicit opt-in, so
    // we keep the user's selection rather than silently downgrading; if the
    // new agent lacks v0.5 the sends will fail loudly (404) rather than lose
    // data silently.
    if (this._useV05) newState.setUseV05(true)
    // Re-apply OTLP routing across the rebuild (these were validated when first
    // set, so re-applying won't throw).
    if (this._otlpEndpoint !== null) {
      newState.setOtlpEndpoint(this._otlpEndpoint)
      if (this._otlpProtocol !== null) newState.setOtlpProtocol(this._otlpProtocol)
      if (this._otlpHeaders !== null) newState.setOtlpHeaders(this._otlpHeaders)
    }

    // Atomic swap: only after the new state is fully constructed do we
    // commit to it and reset JS-side counters.
    this._state = newState
    this._cqbIndex = 8
    this._cqbCount = 0
    this._stringMap.clear()
    this._stringIdCounter = 0

    // Refresh both WASM memory views — buffer/pointer changed with the new
    // state. We must refresh `_cqbBytes` alongside `_cqbView`; `#checkDetach()`
    // only inspects `_cqbView.buffer` and would not detect a `_cqbBytes`-only
    // mismatch, so a missed refresh would silently corrupt the next u128
    // byte-copy in `queueCreateSpan*`.
    this._wasmMemory = wasmMemory
    this._cqbPtr = this._state.change_queue_ptr()
    this.#refreshViews()

    log.debug('Native spans interface reinitialized with new URL:', url)
  }

  /**
   * Reset the change queue buffer.
   * Called after flushing or on error recovery.
   */
  resetChangeQueue () {
    this._cqbIndex = 8
    this._cqbCount = 0
    // Zero out the count header in WASM memory
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
      this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)
    }
    this._cqbView.setUint32(0, 0, true)
    this._cqbView.setUint32(4, 0, true)
  }

  /**
   * Allocate a fresh segment id for a new local trace.
   * @returns {number} The allocated segment id
   */
  allocSegment () {
    return this._nextSegment++
  }

  /**
   * Flush the change queue to native storage.
   * This processes all queued operations in Rust.
   */
  flushChangeQueue () {
    if (this._cqbCount === 0) return

    try {
      this._state.flushChangeQueue()
      this.#checkDetach()
      this.resetChangeQueue()
    } catch (e) {
      // The Rust side may have consumed an unknown prefix of queued ops
      // before throwing, so we cannot tell which ops landed. Reset JS-side
      // state so subsequent queue writes don't clobber a corrupt buffer,
      // refresh views in case memory grew during the partial drain, and
      // surface the failure to the caller.
      this.resetChangeQueue()
      this.#checkDetach()
      // "span not found" means a queued op referenced a span missing from native
      // storage — an orphaned span whose Create never landed (a known upstream
      // defect under heavy span churn; see the native-spans change-buffer
      // investigation). Resetting drops the remainder of this batch, losing
      // those spans, but that must NOT crash the host application — so swallow
      // this specific error. Every other error is a real fault and propagates.
      if (isSpanNotFoundError(e)) {
        log.warn('Native spans: dropped a change-queue batch after "span not found"; affected spans were lost', e)
        return
      }
      log.error('Error flushing change queue to native spans:', e)
      throw e
    }
  }

  /**
   * Get or create a string ID for the string table.
   * Strings are deduplicated to reduce memory usage.
   *
   * @param {string} str The string to intern
   * @returns {number} The string ID
   */
  getStringId (str) {
    let id = this._stringMap.get(str)
    if (typeof id === 'number') return id

    id = this._stringIdCounter++
    // Insert into WASM first; only commit to the JS map if the WASM call
    // succeeds. If `stringTableInsertOne` throws (e.g. OOM during memory
    // grow), we must NOT leave the JS map claiming `str` is interned at
    // `id` — a future `queueOp` would emit a dangling string-id reference.
    // This WASM call may trigger memory growth, detaching the ArrayBuffer.
    this._state.stringTableInsertOne(id, str)
    this.#checkDetach()
    this._stringMap.set(str, id)
    return id
  }

  /**
   * Check if WASM memory was detached (grew) and refresh views if so.
   * Cheap: one reference comparison per call.
   */
  #checkDetach () {
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this.#refreshViews()
    }
  }

  /**
   * Queue an operation to the change buffer.
   *
   * Writes the op record directly into the WASM-side change-queue buffer
   * via cached `_cqbView` / `_cqbBytes` views. See the class doc for the
   * per-arg encoding table.
   *
   * @param {number} op The OpCode value
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, spanId, ...args) {
    // Refresh if a prior call grew memory (e.g. the async stats flush); growth
    // *during* this method is handled by getStringId before the view snapshot.
    this.#checkDetach()
    let idx = this._cqbIndex

    if (idx + 76 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first — these may trigger WASM memory growth.
    // After this loop, views are safe to cache locally.
    const resolvedArgs = args
    for (let i = 0; i < resolvedArgs.length; i++) {
      if (typeof resolvedArgs[i] === 'string') {
        resolvedArgs[i] = this.getStringId(resolvedArgs[i])
      }
    }

    // Grab locals after all WASM calls are done — safe until method returns.
    const view = this._cqbView
    const buf = this._cqbBytes

    // Op header: [opcode u16 LE][span_id u64 LE]. The span_id is the 8-byte
    // LE handle; it replaces the old u32 slot index.
    view.setUint16(idx, op, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    for (let i = 0; i < resolvedArgs.length; i++) {
      const arg = resolvedArgs[i]
      if (typeof arg === 'number') {
        // Pre-resolved string ID
        view.setUint32(idx, arg, true)
        idx += 4
      } else {
        const type = arg[0]
        const value = arg[1]
        switch (type) {
          case 'id64':
            if (value === null || value === undefined) {
              view.setUint32(idx, 0, true)
              view.setUint32(idx + 4, 0, true)
            } else {
              const b = typeof value.toBuffer === 'function' ? value.toBuffer() : (value._buffer ?? value)
              buf[idx] = b[7]; buf[idx + 1] = b[6]; buf[idx + 2] = b[5]; buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]; buf[idx + 5] = b[2]; buf[idx + 6] = b[1]; buf[idx + 7] = b[0]
            }
            idx += 8
            break
          case 'id128': {
            const b = typeof value.toBuffer === 'function' ? value.toBuffer() : (value._buffer ?? value)
            if (b.length > 8) {
              buf[idx] = b[15]; buf[idx + 1] = b[14]; buf[idx + 2] = b[13]; buf[idx + 3] = b[12]
              buf[idx + 4] = b[11]; buf[idx + 5] = b[10]; buf[idx + 6] = b[9]; buf[idx + 7] = b[8]
              idx += 8
              buf[idx] = b[7]; buf[idx + 1] = b[6]; buf[idx + 2] = b[5]; buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]; buf[idx + 5] = b[2]; buf[idx + 6] = b[1]; buf[idx + 7] = b[0]
              idx += 8
            } else {
              buf[idx] = b[7]; buf[idx + 1] = b[6]; buf[idx + 2] = b[5]; buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]; buf[idx + 5] = b[2]; buf[idx + 6] = b[1]; buf[idx + 7] = b[0]
              idx += 8
              view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
              idx += 8
            }
            break
          }
          case 'ns': {
            const ns = Math.round(value * 1e6)
            view.setUint32(idx, ns % 0x1_00_00_00_00, true)
            view.setUint32(idx + 4, Math.floor(ns / 0x1_00_00_00_00), true)
            idx += 8
            break
          }
          case 'i32':
            view.setInt32(idx, value, true)
            idx += 4
            break
          case 'f64':
            view.setFloat64(idx, value, true)
            idx += 8
            break
        }
      }
    }

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true)
  }

  /**
   * Refresh WASM memory views after memory growth (buffer detach).
   */
  #refreshViews () {
    this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
    this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)
  }

  /**
   * Construct a fresh WasmSpanState bound to the given agent URL. Used by
   * the constructor and `setAgentUrl()` so the 15-argument signature lives
   * in exactly one place.
   *
   * @param {string} url Agent URL
   * @returns {WasmSpanState}
   */
  #createWasmState (url) {
    const opts = this._options
    return new WasmSpanState(
      normalizeAgentUrl(url),
      opts.tracerVersion,
      opts.lang,
      opts.langVersion,
      opts.langInterpreter,
      CHANGE_QUEUE_BUFFER_SIZE,
      STRING_TABLE_INPUT_BUFFER_SIZE,
      opts.pid,
      opts.tracerService,
      opts.statsEnabled,
      opts.hostname,
      opts.env,
      opts.appVersion,
      opts.runtimeId,
      opts.clientComputedStats,
    )
  }

  /**
   * Queue a CreateSpan operation (combined Create + SetName + SetStart).
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Uint8Array|number[]} traceId BE Identifier buffer (8 or 16 bytes)
   * @param {number} segmentId The local-trace segment id (u64)
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpan (spanId, traceId, segmentId, parentId, name, startMs) {
    // Refresh if a prior call grew memory. Essential here: when the span name
    // is already interned, getStringId is a cache hit and makes no wasm call,
    // so this is the only refresh point (see the detach-safety invariant).
    this.#checkDetach()
    let idx = this._cqbIndex

    if (idx + 64 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve string ID first (may trigger memory growth)
    const nameId = this.getStringId(name)

    // Cache locals after all WASM calls are done
    const view = this._cqbView
    const buf = this._cqbBytes

    // Header: [opcode u16 = CreateSpan(13)][span_id u64 LE]
    view.setUint16(idx, 13, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    // Args: [trace_id u128][segment_id u64][parent_id u64][name_id u32][start i64]
    // `Identifier` keeps its bytes in a private field (v6 refactor); read via
    // toBuffer(). Fall back to a raw buffer/Uint8Array for callers that pass one.
    const tb = typeof traceId?.toBuffer === 'function' ? traceId.toBuffer() : (traceId._buffer ?? traceId)
    if (tb.length > 8) {
      buf[idx] = tb[15]; buf[idx + 1] = tb[14]; buf[idx + 2] = tb[13]; buf[idx + 3] = tb[12]
      buf[idx + 4] = tb[11]; buf[idx + 5] = tb[10]; buf[idx + 6] = tb[9]; buf[idx + 7] = tb[8]
      idx += 8
      buf[idx] = tb[7]; buf[idx + 1] = tb[6]; buf[idx + 2] = tb[5]; buf[idx + 3] = tb[4]
      buf[idx + 4] = tb[3]; buf[idx + 5] = tb[2]; buf[idx + 6] = tb[1]; buf[idx + 7] = tb[0]
      idx += 8
    } else {
      buf[idx] = tb[7]; buf[idx + 1] = tb[6]; buf[idx + 2] = tb[5]; buf[idx + 3] = tb[4]
      buf[idx + 4] = tb[3]; buf[idx + 5] = tb[2]; buf[idx + 6] = tb[1]; buf[idx + 7] = tb[0]
      idx += 8
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
      idx += 8
    }

    // segment_id u64 LE
    view.setUint32(idx, segmentId % 0x1_00_00_00_00, true)
    view.setUint32(idx + 4, Math.floor(segmentId / 0x1_00_00_00_00), true)
    idx += 8

    if (parentId === null || parentId === undefined) {
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
    } else {
      // `Identifier` keeps its bytes in a private field (v6 refactor); read via
      // toBuffer() — `._buffer` is undefined, which previously zeroed parent_id
      // and exported every child span as a root.
      const pb = typeof parentId.toBuffer === 'function' ? parentId.toBuffer() : (parentId._buffer ?? parentId)
      buf[idx] = pb[7]; buf[idx + 1] = pb[6]; buf[idx + 2] = pb[5]; buf[idx + 3] = pb[4]
      buf[idx + 4] = pb[3]; buf[idx + 5] = pb[2]; buf[idx + 6] = pb[1]; buf[idx + 7] = pb[0]
    }
    idx += 8

    view.setUint32(idx, nameId, true)
    idx += 4

    const ns = Math.round(startMs * 1e6)
    view.setUint32(idx, ns % 0x1_00_00_00_00, true)
    view.setUint32(idx + 4, Math.floor(ns / 0x1_00_00_00_00), true)
    idx += 8

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true)
  }

  /**
   * Queue multiple meta (string) tags using the BatchSetMeta opcode.
   * Single header, N key/value pairs. Written directly to WASM memory.
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Array<[string, string]>} tags Array of [key, value] pairs
   */
  queueBatchMeta (spanId, tags) {
    if (tags.length === 0) return

    this.#checkDetach() // refresh if a prior call grew memory (see queueOp)
    let idx = this._cqbIndex
    const needed = 16 + tags.length * 8

    if (idx + needed > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first (may trigger memory growth)
    const ids = new Array(tags.length * 2)
    for (let i = 0; i < tags.length; i++) {
      ids[i * 2] = this.getStringId(tags[i][0])
      ids[i * 2 + 1] = this.getStringId(tags[i][1])
    }

    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 15, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, tags.length, true)
    idx += 4
    for (let i = 0; i < tags.length; i++) {
      view.setUint32(idx, ids[i * 2], true)
      idx += 4
      view.setUint32(idx, ids[i * 2 + 1], true)
      idx += 4
    }

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true)
  }

  /**
   * Queue multiple metric tags using the BatchSetMetric opcode.
   * Single header, N key/value pairs. Written directly to WASM memory.
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Array<[string, number]>} tags Array of [key, value] pairs
   */
  queueBatchMetrics (spanId, tags) {
    if (tags.length === 0) return

    this.#checkDetach() // refresh if a prior call grew memory (see queueOp)
    let idx = this._cqbIndex
    const needed = 16 + tags.length * 12

    if (idx + needed > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first (may trigger memory growth)
    const keyIds = new Array(tags.length)
    for (let i = 0; i < tags.length; i++) {
      keyIds[i] = this.getStringId(tags[i][0])
    }

    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 16, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, tags.length, true)
    idx += 4
    for (let i = 0; i < tags.length; i++) {
      view.setUint32(idx, keyIds[i], true)
      idx += 4
      view.setFloat64(idx, tags[i][1], true)
      idx += 8
    }

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true)
  }

  /**
   * Set a `meta_struct` entry on a span. `meta_struct` carries msgpack-encoded
   * structured data (AppSec, Code Origin, Dynamic Instrumentation) and has no
   * change-buffer opcode, so the WASM binding writes it directly onto the span
   * after draining its own change queue. We must therefore drain the JS-tracked
   * queue first, otherwise `_cqbIndex`/`_cqbCount` would fall out of sync with
   * the now-zeroed WASM header and the next `queueOp` would re-apply stale ops.
   *
   * @param {Uint8Array} spanId The 8-byte LE span id handle
   * @param {string} key The meta_struct key
   * @param {Uint8Array} bytes The msgpack-encoded value
   */
  setMetaStruct (spanId, key, bytes) {
    this.flushChangeQueue()
    // WasmSpanState addresses spans by their numeric u64 id (a BigInt across
    // the wasm boundary). `_nativeSpanId` is stored little-endian and the change
    // buffer keys spans by that same LE interpretation (queueOp/queueCreateSpan
    // copy the LE bytes into `[span_id u64 LE]`), so decode little-endian here
    // too — otherwise meta_struct attaches to the wrong/nonexistent span.
    const id = new DataView(spanId.buffer, spanId.byteOffset, 8).getBigUint64(0, true)
    this._state.setMetaStruct(id, key, bytes)
    // setMetaStruct inserts into a Vec, which can grow WASM memory and detach
    // our cached views — refresh before the next queueOp.
    this.#checkDetach()
  }

  /**
   * Append an OpenTelemetry-style span event to a span's top-level v0.4
   * `span_events` field. Like meta_struct there is no change-buffer opcode, so
   * the queue is drained first and the event appended directly (ordering-safe).
   *
   * @param {Uint8Array} spanId - the 8-byte span handle (`_nativeSpanId`).
   * @param {string} name - event name.
   * @param {bigint} timeUnixNano - event timestamp in nanoseconds (u64).
   * @param {Uint8Array} attrsBuf - flat typed attribute buffer (see
   *   `decode_span_event_attributes` in the pipeline crate).
   */
  addSpanEvent (spanId, name, timeUnixNano, attrsBuf) {
    this.flushChangeQueue()
    // Little-endian to match how the change buffer keys spans (see setMetaStruct).
    const id = new DataView(spanId.buffer, spanId.byteOffset, 8).getBigUint64(0, true)
    this._state.addSpanEvent(id, name, timeUnixNano, attrsBuf)
    // addSpanEvent appends to a Vec, which can grow WASM memory and detach
    // our cached views — refresh before the next queueOp.
    this.#checkDetach()
  }

  /**
   * Flush spans to the Datadog agent.
   *
   * @param {Array<Uint8Array>} spanIds Array of 8-byte LE span ids
   * @param {boolean} [firstIsLocalRoot] Whether the first span is the local root (defaults to true)
   * @returns {Promise<string>} Response from the agent
   */
  /**
   * Flush one trace's spans. Thin wrapper over {@link flushSpansGrouped} for a
   * single chunk; the exporter uses the grouped form so each request carries one
   * chunk per trace.
   */
  flushSpans (spanIds, firstIsLocalRoot = true) {
    return this.flushSpansGrouped([{ spanIds, firstIsLocalRoot }])
  }

  /**
   * Prepare one chunk per trace and send them as a single multi-trace request.
   *
   * Each group is `{ spanIds, firstIsLocalRoot }` for exactly one trace
   * (segment), with the local-root span first. Grouping by trace is essential:
   * `flush_chunk` treats a chunk as a single segment and copies that segment's
   * trace-level tags (sampling priority, `_dd.p.dm`, origin, top_level) onto its
   * local root. Passing many traces as one chunk would lump distinct trace_ids
   * together and stamp only the first — corrupting sampling/grouping under load.
   *
   * @param {Array<{spanIds: Uint8Array[], firstIsLocalRoot: boolean}>} groups
   */
  flushSpansGrouped (groups) {
    // Drain all pending ops (creates, tags, per-trace sampling/trace tags) once
    // up front so every chunk prepared below sees a fully-applied span map.
    this.flushChangeQueue()

    let prepared = 0
    for (const group of groups) {
      const spanIds = group.spanIds
      if (!spanIds || spanIds.length === 0) continue

      // Ensure flush buffer is large enough (8 bytes per u64 span id). The
      // buffer is reused across groups: prepareChunk is synchronous and copies
      // the ids out before returning, so overwriting it next iteration is safe.
      const requiredSize = spanIds.length * 8
      if (requiredSize > this._flushBuffer.length) {
        this._flushBuffer = Buffer.alloc(requiredSize)
      }

      // Write span ids to the flush buffer as u64 LE (the ids are already LE)
      let index = 0
      for (const spanId of spanIds) {
        this._flushBuffer.set(spanId, index)
        index += 8
      }

      try {
        // prepareChunk extracts this trace's spans and stages a chunk; multiple
        // calls accumulate in native storage until sendPreparedChunk.
        const has = this._state.prepareChunk(spanIds.length, group.firstIsLocalRoot, this._flushBuffer)
        // prepareChunk (flush_change_buffer + flush_chunk) can allocate and grow
        // WASM memory, detaching our cached views; refresh before the next write.
        this.#checkDetach()
        if (has) prepared++
      } catch (e) {
        // prepareChunk may throw partway through, after consuming some of the
        // change queue or growing WASM memory. Reset JS-side queue state and
        // refresh views so the next caller starts from a known-good baseline.
        // Already-staged chunks from earlier groups are dropped with the
        // rejection (they were extracted out of native storage).
        this.resetChangeQueue()
        this.#checkDetach()
        log.error('Error preparing spans to flush:', e)
        return Promise.reject(e)
      }
    }

    if (prepared === 0) {
      return Promise.resolve('no spans to flush')
    }

    return this._state.sendPreparedChunk()
      .catch(e => {
        // A send failure is a *network* fault for the already-serialized chunks;
        // those are lost, which is expected on a transient agent outage.
        //
        // Crucially, do NOT resetChangeQueue() here. sendPreparedChunk is async,
        // so by the time this rejection lands, ops for *other* spans (including
        // their Create) have typically been queued into the shared change buffer
        // while the send was in flight. Resetting would discard those pending
        // ops, orphaning spans whose Create never lands in native storage -> a
        // "span not found" at their next flush (and, before the change-buffer
        // became tolerant, a cascade that crashed the host). The change buffer
        // was already drained before prepareChunk, so it holds only that valid
        // pending work; leave it intact for the next flush. Only refresh views
        // (memory may have grown during the send) and propagate the error.
        this.#checkDetach()
        log.error('Error flushing spans to agent:', e)
        throw e
      })
  }

  // Note: sample() is not available in the WASM pipeline module.
  // Sampling is handled by the JS-side priority sampler.
}

module.exports = NativeSpansInterface
