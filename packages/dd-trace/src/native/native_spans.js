'use strict'

const { callbackify } = require('node:util')

const log = require('../log')
const { WasmSpanState, wasmMemory } = require('./index')

// A queued op (or an extracted chunk) referenced a span id that is absent from
// native storage. The wasm error may arrive as an Error or a bare string.
function isSpanNotFoundError (e) {
  return /span not found/.test(String(e != null && e.message != null ? e.message : e))
}

function spanNotFoundId (e) {
  const match = /span not found[^0-9]*(\d+)/.exec(String(e != null && e.message != null ? e.message : e))
  return match ? BigInt(match[1]) : null
}

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024 // 8MB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB
const EMPTY_FLUSH_BUFFER = Buffer.alloc(0)

// OpCode values are small u32 integers, written as u64 LE via two u32 writes.

/**
 * JS bridge to native span storage.
 *
 * Cached WASM views must be refreshed after any call that can grow memory.
 * Queue methods check at entry for growth by earlier async calls; methods that
 * call WASM refresh again before retaining or using a view.
 *
 * Change queue layout:
 *   [count: u64 LE]
 *   [opcode: u16 LE][spanId: u64 LE][payload]...
 *
 * Generic arguments encode as a string id (`number`), `id64`, `id128`, `ns`,
 * `i32`, or `f64`. Identifier buffers arrive big-endian and are written
 * little-endian for WASM.
 */

/**
 * Convert the legacy `unix://./pipe/...` Windows-pipe form to libdatadog's
 * `windows:` scheme. Unix sockets and HTTP URLs pass through unchanged.
 * @param {string} url Agent URL
 * @returns {string} URL accepted by libdatadog
 */
function normalizeAgentUrl (url) {
  if (typeof url === 'string' && url.startsWith('unix://./')) {
    return 'windows:' + url.slice('unix:'.length)
  }
  return url
}

class NativeSpansInterface {
  #sendInFlight = false
  #sendPreparedChunk
  #otlpEndpoint
  #otlpHeaders
  #otlpProtocol
  #useV05 = false

  /**
   * @param {object} options Configuration options
   * @param {string} options.agentUrl URL of the Datadog agent
   * @param {string} options.tracerVersion Version of dd-trace
   * @param {string} [options.lang] Language identifier (defaults to 'nodejs')
   * @param {string} [options.langVersion] Language version (defaults to process.version)
   * @param {string} [options.langInterpreter] Language interpreter (defaults to 'v8')
   * @param {number} [options.pid] Process ID (defaults to process.pid)
   * @param {string} options.tracerService Default service name
   * @param {boolean} [options.clientComputedStats] Whether traces carry client-computed stats
   * @param {boolean} [options.otelSemanticsEnabled] Whether OTel HTTP remapping is enabled
   */
  constructor (options) {
    if (!WasmSpanState) {
      throw new Error('Native spans module is not available')
    }

    this._options = {
      tracerVersion: options.tracerVersion,
      lang: options.lang || 'nodejs',
      langVersion: options.langVersion || process.version,
      langInterpreter: options.langInterpreter || 'v8',
      pid: options.pid ?? process.pid,
      tracerService: options.tracerService,
      clientComputedStats: options.clientComputedStats || false,
    }
    this.otelSemanticsEnabled = options.otelSemanticsEnabled || false

    // Flush buffer for span export
    this._flushBuffer = Buffer.alloc(FLUSH_BUFFER_SIZE)

    // Change queue buffer state
    // First 8 bytes store the count of operations
    this._cqbIndex = 8
    this._cqbCount = 0

    // One segment id per local trace.
    this._nextSegment = 0

    // String ids live only as long as queued/native work.
    this._stringMap = new Map()
    this._stringIdCounter = 0

    this._state = this.#createWasmState(options.agentUrl)
    this.#sendPreparedChunk = callbackify(this._state.sendPreparedChunk)

    // Get the WASM memory views for writing to the change queue buffer
    this._wasmMemory = wasmMemory
    this._cqbPtr = this._state.change_queue_ptr()
    this.#refreshViews()

    log.debug('Native spans interface initialized')
  }

  /**
   * Select trace intake v0.5 for subsequent sends.
   * @param {boolean} useV05 Whether to use v0.5
   */
  setUseV05 (useV05) {
    this._state.setUseV05(useV05)
    this.#useV05 = useV05
  }

  /**
   * Select native OTLP export.
   * @param {string} url OTLP trace endpoint
   */
  setOtlpEndpoint (url) {
    this._state.setOtlpEndpoint(url)
    this.#otlpEndpoint = url
  }

  /**
   * Select the OTLP transport protocol.
   * @param {string} protocol OTLP transport protocol
   */
  setOtlpProtocol (protocol) {
    this._state.setOtlpProtocol(protocol)
    this.#otlpProtocol = protocol
  }

  /**
   * Set flattened OTLP request headers.
   * @param {string[]} headers Alternating header names and values
   */
  setOtlpHeaders (headers) {
    this._state.setOtlpHeaders(headers)
    this.#otlpHeaders = headers
  }

  /**
   * Rebuild native state for a new agent URL. The exporter calls this only
   * after active spans, pending chunks, and the current send have drained.
   * @param {string} url New agent URL
   */
  setAgentUrl (url) {
    if (this.#sendInFlight) {
      throw new Error('cannot replace native span state while a send is in flight')
    }

    this.flushChangeQueue()
    const newState = this.#createWasmState(url)
    if (this.#useV05) newState.setUseV05(true)
    if (this.#otlpEndpoint !== undefined) {
      newState.setOtlpEndpoint(this.#otlpEndpoint)
      if (this.#otlpProtocol !== undefined) newState.setOtlpProtocol(this.#otlpProtocol)
      if (this.#otlpHeaders !== undefined) newState.setOtlpHeaders(this.#otlpHeaders)
    }
    const sendPreparedChunk = callbackify(newState.sendPreparedChunk)
    const oldState = this._state

    this._state = newState
    this.#sendPreparedChunk = sendPreparedChunk
    this._cqbIndex = 8
    this._cqbCount = 0
    this._stringMap.clear()
    this._stringIdCounter = 0
    this._wasmMemory = wasmMemory
    this._cqbPtr = newState.change_queue_ptr()
    this.#refreshViews()
    oldState.free()

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
      this._cqbBytes = new Uint8Array(this._cqbView.buffer, this._cqbView.byteOffset, this._cqbView.byteLength)
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
      const preserved = this.#copyOpsAfterSpanNotFound(e)
      this.resetChangeQueue()
      this.#checkDetach()
      if (preserved !== null) {
        this.#restoreQueuedOps(preserved)
        if (preserved.count > 0) this.flushChangeQueue()
        log.warn(
          'Native spans: dropped one orphaned span operation after "span not found"; preserved %d later operation(s)',
          preserved.count,
          e
        )
        return
      }
      // An unidentifiable orphan drops the batch rather than crashing the app.
      if (isSpanNotFoundError(e)) {
        log.warn('Native spans: dropped a change-queue batch after "span not found"; affected spans were lost', e)
        return
      }
      log.error('Error flushing change queue to native spans:', e)
      throw e
    }
  }

  #copyOpsAfterSpanNotFound (error) {
    const missing = spanNotFoundId(error)
    if (missing === null) return null

    try {
      let offset = 8
      for (let i = 0; i < this._cqbCount; i++) {
        const start = offset
        const spanId = this._cqbView.getBigUint64(start + 2, true)
        offset = this.#nextOpOffset(offset)
        if (spanId === missing) {
          const remaining = this._cqbCount - i - 1
          if (remaining <= 0) return { bytes: null, count: 0 }
          return {
            bytes: this._cqbBytes.slice(offset, this._cqbIndex),
            count: remaining,
          }
        }
      }
    } catch {
      return null
    }
    return null
  }

  #nextOpOffset (offset) {
    const op = this._cqbView.getUint16(offset, true)
    offset += 10
    switch (op) {
      case 1: // SetMetaAttr
      case 10: // SetTraceMetaAttr
        return offset + 8
      case 2: // SetMetricAttr
      case 11: // SetTraceMetricsAttr
        return offset + 12
      case 3: // SetServiceName
      case 4: // SetResourceName
      case 8: // SetType
      case 9: // SetName
      case 12: // SetTraceOrigin
        return offset + 4
      case 5: // SetError
        return offset + 4
      case 6: // SetStart
      case 7: // SetDuration
        return offset + 8
      case 13: // CreateSpan
        return offset + 44
      case 14: // CreateSpanFull
        return offset + 56
      case 15: { // BatchSetMeta
        const count = this._cqbView.getUint32(offset, true)
        return offset + 4 + count * 8
      }
      case 16: { // BatchSetMetric
        const count = this._cqbView.getUint32(offset, true)
        return offset + 4 + count * 12
      }
      default:
        throw new Error(`unknown native span op ${op}`)
    }
  }

  #restoreQueuedOps ({ bytes, count }) {
    if (count === 0 || bytes === null) return
    this._cqbBytes.set(bytes, 8)
    this._cqbIndex = 8 + bytes.length
    this._cqbCount = count
    this._cqbView.setUint32(0, count, true)
    this._cqbView.setUint32(4, 0, true)
  }

  #evictStringTable (resetCounter = false) {
    if (resetCounter) this._stringIdCounter = 0
    if (this._stringMap.size === 0) return

    const evict = this._state.stringTableEvict
    if (typeof evict === 'function') {
      for (const id of this._stringMap.values()) {
        evict.call(this._state, id)
      }
    }
    this._stringMap.clear()
  }

  #evictIdleStringTable () {
    if (this._cqbCount === 0) this.#evictStringTable(false)
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
    // Commit to the JS map only after the WASM insertion succeeds.
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
   * Append an operation directly to the WASM change queue.
   * @param {number} op OpCode value
   * @param {Uint8Array} spanId 8-byte little-endian span id
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, spanId, ...args) {
    // Catch memory growth from an earlier call before taking local views.
    this.#checkDetach()
    this.#evictIdleStringTable()
    let idx = this._cqbIndex

    if (idx + 76 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve strings before taking views because interning can grow memory.
    const resolvedArgs = args
    for (let i = 0; i < resolvedArgs.length; i++) {
      if (typeof resolvedArgs[i] === 'string') {
        resolvedArgs[i] = this.getStringId(resolvedArgs[i])
      }
    }

    const view = this._cqbView
    const buf = this._cqbBytes

    // [opcode u16 LE][span_id u64 LE]
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
            } else {
              buf[idx] = b[7]; buf[idx + 1] = b[6]; buf[idx + 2] = b[5]; buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]; buf[idx + 5] = b[2]; buf[idx + 6] = b[1]; buf[idx + 7] = b[0]
              idx += 8
              view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
            }
            idx += 8
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
    this._cqbBytes = new Uint8Array(this._cqbView.buffer, this._cqbView.byteOffset, this._cqbView.byteLength)
  }

  /**
   * Construct a state through the binding's positional API.
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
      false,
      '',
      '',
      '',
      '',
      opts.clientComputedStats,
    )
  }

  /**
   * Queue a CreateSpanFull operation (Create + name + service + resource + type + start).
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Uint8Array|number[]} traceId BE Identifier buffer (8 or 16 bytes)
   * @param {number} segmentId The local-trace segment id (u64)
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {string} service Service name
   * @param {string} resource Resource name
   * @param {string} type Span type
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpanFull (spanId, traceId, segmentId, parentId, name, service, resource, type, startMs) {
    this.#checkDetach()
    this.#evictIdleStringTable()
    let idx = this._cqbIndex

    if (idx + 76 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    const nameId = this.getStringId(name)
    const serviceId = this.getStringId(service)
    const resourceId = this.getStringId(resource)
    const typeId = this.getStringId(type)

    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 14, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    const tb = typeof traceId?.toBuffer === 'function' ? traceId.toBuffer() : (traceId._buffer ?? traceId)
    if (tb.length > 8) {
      buf[idx] = tb[15]; buf[idx + 1] = tb[14]; buf[idx + 2] = tb[13]; buf[idx + 3] = tb[12]
      buf[idx + 4] = tb[11]; buf[idx + 5] = tb[10]; buf[idx + 6] = tb[9]; buf[idx + 7] = tb[8]
      idx += 8
      buf[idx] = tb[7]; buf[idx + 1] = tb[6]; buf[idx + 2] = tb[5]; buf[idx + 3] = tb[4]
      buf[idx + 4] = tb[3]; buf[idx + 5] = tb[2]; buf[idx + 6] = tb[1]; buf[idx + 7] = tb[0]
    } else {
      buf[idx] = tb[7]; buf[idx + 1] = tb[6]; buf[idx + 2] = tb[5]; buf[idx + 3] = tb[4]
      buf[idx + 4] = tb[3]; buf[idx + 5] = tb[2]; buf[idx + 6] = tb[1]; buf[idx + 7] = tb[0]
      idx += 8
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
    }
    idx += 8

    view.setUint32(idx, segmentId % 0x1_00_00_00_00, true)
    view.setUint32(idx + 4, Math.floor(segmentId / 0x1_00_00_00_00), true)
    idx += 8

    if (parentId === null || parentId === undefined) {
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
    } else {
      const pb = typeof parentId.toBuffer === 'function' ? parentId.toBuffer() : (parentId._buffer ?? parentId)
      buf[idx] = pb[7]; buf[idx + 1] = pb[6]; buf[idx + 2] = pb[5]; buf[idx + 3] = pb[4]
      buf[idx + 4] = pb[3]; buf[idx + 5] = pb[2]; buf[idx + 6] = pb[1]; buf[idx + 7] = pb[0]
    }
    idx += 8

    view.setUint32(idx, nameId, true)
    idx += 4
    view.setUint32(idx, serviceId, true)
    idx += 4
    view.setUint32(idx, resourceId, true)
    idx += 4
    view.setUint32(idx, typeId, true)
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
   * Queue multiple meta tags from a flat scratch array: [key, value, ...].
   * Mutates the scratch array to interned string ids before taking WASM views.
   * Used by the Span#addTags hot path to avoid per-tag pair arrays.
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Array<string|number>} tags Alternating key/value entries
   */
  queueBatchMetaFlat (spanId, tags) {
    const count = tags.length >> 1
    if (count === 0) return

    this.#checkDetach() // refresh if a prior call grew memory (see queueOp)
    this.#evictIdleStringTable()
    let idx = this._cqbIndex
    const needed = 16 + count * 8

    if (idx + needed > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first (may trigger memory growth). This array is a
    // local scratch buffer from syncToNativeOnly, so mutating it is safe.
    for (let i = 0; i < tags.length; i++) {
      tags[i] = this.getStringId(tags[i])
    }

    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 15, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, count, true)
    idx += 4
    for (let i = 0; i < tags.length; i += 2) {
      view.setUint32(idx, tags[i], true)
      idx += 4
      view.setUint32(idx, tags[i + 1], true)
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
    this.#evictIdleStringTable()
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
   * Queue multiple metric tags from a flat scratch array: [key, value, ...].
   * Mutates key slots to interned string ids before taking WASM views. Used by
   * the Span#addTags hot path to avoid per-tag pair arrays.
   *
   * @param {Uint8Array} spanId The 8-byte LE span id (op handle)
   * @param {Array<string|number>} tags Alternating key/value entries
   */
  queueBatchMetricsFlat (spanId, tags) {
    const count = tags.length >> 1
    if (count === 0) return

    this.#checkDetach() // refresh if a prior call grew memory (see queueOp)
    this.#evictIdleStringTable()
    let idx = this._cqbIndex
    const needed = 16 + count * 12

    if (idx + needed > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first (may trigger memory growth). This array is a
    // local scratch buffer from syncToNativeOnly, so mutating it is safe.
    for (let i = 0; i < tags.length; i += 2) {
      tags[i] = this.getStringId(tags[i])
    }

    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 16, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, count, true)
    idx += 4
    for (let i = 0; i < tags.length; i += 2) {
      view.setUint32(idx, tags[i], true)
      idx += 4
      view.setFloat64(idx, tags[i + 1], true)
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
   * Append a typed event directly after draining queued operations.
   * @param {Uint8Array} spanId 8-byte span handle
   * @param {string} name Event name
   * @param {bigint} timeUnixNano Event timestamp
   * @param {Uint8Array} attrsBuf Encoded typed attributes
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
   * Remove finished spans without sending the prepared chunks.
   * @param {Array<{spanIds: Uint8Array[], firstIsLocalRoot: boolean}>} groups
   * @returns {number} Number of non-empty groups discarded
   */
  discardSpansGrouped (groups) {
    this.flushChangeQueue()

    let discarded = 0
    try {
      for (const group of groups) {
        const spanIds = group.spanIds
        if (!spanIds || spanIds.length === 0) continue
        this.#prepareGroup(group)
        discarded++
      }

      if (discarded > 0) {
        this._state.prepareChunk(0, true, EMPTY_FLUSH_BUFFER)
        this.#checkDetach()
      }
      this.#evictStringTable(true)
      return discarded
    } catch (e) {
      this.resetChangeQueue()
      this.#checkDetach()
      if (discarded > 0) {
        try {
          this._state.prepareChunk(0, true, EMPTY_FLUSH_BUFFER)
          this.#checkDetach()
        } catch {
          // Best-effort cleanup: the caller will still fall back to the idle
          // whole-state reset path when possible.
        }
      }
      log.warn('Native spans: failed to discard dropped spans from native storage:', e)
      return discarded
    }
  }

  #prepareGroup (group) {
    const spanIds = group.spanIds
    const requiredSize = spanIds.length * 8
    if (requiredSize > this._flushBuffer.length) {
      this._flushBuffer = Buffer.alloc(requiredSize)
    }

    let index = 0
    for (const spanId of spanIds) {
      this._flushBuffer.set(spanId, index)
      index += 8
    }

    const has = this._state.prepareChunk(spanIds.length, group.firstIsLocalRoot, this._flushBuffer)
    this.#checkDetach()
    return has
  }

  /**
   * Prepare one chunk per trace and send them in one request.
   * @param {Array<{spanIds: Uint8Array[], firstIsLocalRoot: boolean}>} groups
   * @param {(error?: Error, response?: string) => void} done
   */
  flushSpansGrouped (groups, done) {
    try {
      this.flushChangeQueue()

      let prepared = 0
      for (const group of groups) {
        const spanIds = group.spanIds
        if (!spanIds || spanIds.length === 0) continue
        if (this.#prepareGroup(group)) prepared++
      }
      this.#evictStringTable(true)

      if (prepared === 0) {
        done(undefined, 'no spans to flush')
        return
      }

      this.#sendInFlight = true
      this.#sendPreparedChunk.call(this._state, (error, response) => {
        this.#sendInFlight = false
        this.#checkDetach()
        if (error) log.error('Error flushing spans to agent:', error)
        done(error, response)
      })
    } catch (error) {
      this.resetChangeQueue()
      this.#checkDetach()
      this.#evictStringTable(true)
      log.error('Error preparing spans to flush:', error)
      done(error)
    }
  }
}

module.exports = NativeSpansInterface
