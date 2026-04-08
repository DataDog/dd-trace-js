'use strict'

const { WasmSpanState, OpCode, wasmMemory } = require('./index')
const log = require('../log')

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024 // 8MB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB

// OpCode values: simple ops use (field_idx << 3) | kind (values 0-31);
// complex ops (Create=32, CreateSpan=33, CreateSpanFull=34, BatchSetMeta=35, BatchSetMetric=36).

/**
 * NativeSpansInterface provides the JavaScript bridge to the native span storage.
 *
 * It manages:
 * - Shared buffers for efficient data transfer to/from Rust
 * - The change buffer protocol for queuing span operations
 * - The string table for string deduplication
 * - Span export to the Datadog agent
 */
class NativeSpansInterface {
   /**
    * @param {Object} options Configuration options
    * @param {string} options.agentUrl URL of the Datadog agent
    * @param {string} options.tracerVersion Version of dd-trace
    * @param {string} [options.lang='nodejs'] Language identifier
    * @param {string} [options.langVersion] Language version (defaults to process.version)
    * @param {string} [options.langInterpreter='v8'] Language interpreter
    * @param {number} [options.pid] Process ID (defaults to process.pid)
    * @param {string} options.tracerService Default service name
    * @param {boolean} [options.statsEnabled=false] Enable native stats collection
    * @param {string} [options.hostname=''] Hostname for stats payload
    * @param {string} [options.env=''] Environment for stats payload
    * @param {string} [options.appVersion=''] App version for stats payload
    * @param {string} [options.runtimeId=''] Runtime ID for stats payload
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
    }

    // Flush buffer for span export
    this._flushBuffer = Buffer.alloc(FLUSH_BUFFER_SIZE)

    // Change queue buffer state
    // First 4 bytes store the count of operations (u32)
    this._cqbIndex = 4
    this._cqbCount = 0




    // String table state
    this._stringMap = new Map()
    this._stringIdCounter = 0

    // Initialize the WASM state (buffers are allocated in WASM memory)
    this._state = new WasmSpanState(
      options.agentUrl,
      this._options.tracerVersion,
      this._options.lang,
      this._options.langVersion,
      this._options.langInterpreter,
      CHANGE_QUEUE_BUFFER_SIZE,
      STRING_TABLE_INPUT_BUFFER_SIZE,
      this._options.pid,
      this._options.tracerService,
      this._options.statsEnabled,
      this._options.hostname,
      this._options.env,
      this._options.appVersion,
      this._options.runtimeId,
    )

    // Get the WASM memory views for writing to the change queue buffer
    this._wasmMemory = wasmMemory
    this._cqbPtr = this._state.change_queue_ptr()
    this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
    this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)

    // Start stats flush interval if stats are enabled
    if (this._options.statsEnabled) {
      this._statsInterval = setInterval(() => {
        this._state.flushStats(false).catch((err) => {
          log.error('Error flushing native stats:', err)
        })
      }, 10000)
      this._statsInterval.unref()

      // Force flush stats on process exit
      const handler = () => {
        this._state.flushStats(true).catch(() => {})
      }
      if (globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers) {
        globalThis[Symbol.for('dd-trace')].beforeExitHandlers.push(handler)
      }
    }

    log.debug('Native spans interface initialized')
  }

  /**
   * Flush aggregated stats to the agent.
   * @param {boolean} [force=false] Force flush all buckets (for shutdown)
   * @returns {Promise<boolean>}
   */
  flushStats (force = false) {
    if (!this._state) return Promise.resolve(false)
    return this._state.flushStats(force)
  }

  /**
   * Update the agent URL by reinitializing the native state.
   * Warning: This will discard any buffered but unflushed span data.
   * @param {string} url New agent URL
   */
  setAgentUrl (url) {
    // Flush any pending operations first
    this.flushChangeQueue()

    // Reset change queue state
    this._cqbIndex = 4
    this._cqbCount = 0

    // Reset string table (spans will need to re-register strings)
    this._stringMap.clear()
    this._stringIdCounter = 0

    // Reinitialize WASM state with new URL
    this._state = new WasmSpanState(
      url,
      this._options.tracerVersion,
      this._options.lang,
      this._options.langVersion,
      this._options.langInterpreter,
      CHANGE_QUEUE_BUFFER_SIZE,
      STRING_TABLE_INPUT_BUFFER_SIZE,
      this._options.pid,
      this._options.tracerService,
      this._options.statsEnabled,
      this._options.hostname,
      this._options.env,
      this._options.appVersion,
      this._options.runtimeId,
    )

    // Update WASM memory pointers (may have changed after reallocation)
    this._wasmMemory = wasmMemory
    this._cqbPtr = this._state.change_queue_ptr()
    this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)

    log.debug('Native spans interface reinitialized with new URL:', url)
  }

  /**
   * Get the OpCode enum for use by span classes.
   * @returns {typeof OpCode}
   */
  get OpCode () {
    return OpCode
  }

  /**
   * Get the underlying NativeSpanState for direct access when needed.
   * @returns {NativeSpanState}
   */
  get state () {
    return this._state
  }

  /**
   * Reset the change queue buffer.
   * Called after flushing or on error recovery.
   */
  resetChangeQueue () {
    this._cqbIndex = 4
    this._cqbCount = 0
    // Zero out the count header in WASM memory
    if (this._wasmMemory.buffer !== this._cqbView.buffer) {
      this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
      this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)
    }
    this._cqbView.setUint32(0, 0, true)
  }

  /**
   * Flush the change queue to native storage.
   * This processes all queued operations in Rust.
   */
  flushChangeQueue () {
    if (this._cqbCount === 0) return

    try {
      this._state.flushChangeQueue()
    } catch (e) {
      log.error('Error flushing change queue to native spans:', e)
    }
    this.#checkDetach()
    this.resetChangeQueue()
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
    this._stringMap.set(str, id)
    // This WASM call may trigger memory growth, detaching the ArrayBuffer.
    this._state.stringTableInsertOne(id, str)
    this.#checkDetach()
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
   * Evict a string from the string table.
   * Should be called when a string is no longer referenced.
   *
   * @param {string} str The string to evict
   */
  evictString (str) {
    const id = this._stringMap.get(str)
    if (typeof id === 'number') {
      this._state.stringTableEvict(id)
      this._stringMap.delete(str)
    }
  }

  /**
   * Queue an operation to the change buffer.
   *
   * Stages the operation in a JS-side buffer (fast writes), then copies
   * it to WASM memory in a single Uint8Array.set() call.
   *
   * @param {number} op The OpCode value
   * @param {Uint8Array} spanId The span ID as a little-endian byte buffer
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, spanId, ...args) {
    this.#ensureWasmViews()

    let idx = this._cqbIndex

    if (idx + 80 > CHANGE_QUEUE_BUFFER_SIZE) {
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

    view.setUint16(idx, op, true)
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    for (let i = 0; i < resolvedArgs.length; i++) {
      const arg = resolvedArgs[i]
      if (typeof arg === 'number') {
        // Pre-resolved string ID
        view.setUint16(idx, arg, true)
        idx += 2
      } else {
        const type = arg[0]
        const value = arg[1]
        switch (type) {
          case 'id64':
            if (value === null || value === undefined) {
              view.setUint32(idx, 0, true)
              view.setUint32(idx + 4, 0, true)
            } else {
              const b = value._buffer ?? value
              buf[idx] = b[7]; buf[idx + 1] = b[6]; buf[idx + 2] = b[5]; buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]; buf[idx + 5] = b[2]; buf[idx + 6] = b[1]; buf[idx + 7] = b[0]
            }
            idx += 8
            break
          case 'id128': {
            const b = value._buffer ?? value
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
            view.setUint32(idx, ns % 0x100000000, true)
            view.setUint32(idx + 4, Math.floor(ns / 0x100000000), true)
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
  }

  /**
   * Increment the op count and write it to WASM memory.
   * Checks for detach first since a getStringId call may have grown memory.
   */
  #updateCount () {
    this.#checkDetach()
    this._cqbCount++
    this._cqbView.setUint32(0, this._cqbCount, true)
  }

  /**
   * Ensure WASM memory views are fresh (memory may have grown).
   * Also checks if Rust drained the queue.
   */
  #ensureWasmViews () {
    if (this._wasmMemory.buffer !== this._cqbView.buffer || this._cqbBytes.buffer.byteLength === 0) {
      this.#refreshViews()
    }
    if (this._cqbView.getUint32(0, true) === 0 && this._cqbCount > 0) {
      this._cqbIndex = 4
      this._cqbCount = 0
    }
  }

  /**
   * Refresh WASM memory views after memory growth (buffer detach).
   */
  #refreshViews () {
    this._cqbView = new DataView(this._wasmMemory.buffer, this._cqbPtr)
    this._cqbBytes = new Uint8Array(this._wasmMemory.buffer, this._cqbPtr)
  }

  /**
   * Queue a CreateSpan operation (combined Create + SetName + SetStart).
   *
   * @param {Uint8Array} spanId LE span ID
   * @param {Uint8Array|number[]} traceId BE Identifier buffer (8 or 16 bytes)
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpan (spanId, traceId, parentId, name, startMs) {
    this.#ensureWasmViews()

    let idx = this._cqbIndex

    if (idx + 44 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve string ID first (may trigger memory growth)
    const nameId = this.getStringId(name)

    // Cache locals after all WASM calls are done
    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 33, true) // CreateSpan
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    const tb = traceId._buffer ?? traceId
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

    if (parentId === null || parentId === undefined) {
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
    } else {
      const pb = parentId._buffer ?? parentId
      buf[idx] = pb[7]; buf[idx + 1] = pb[6]; buf[idx + 2] = pb[5]; buf[idx + 3] = pb[4]
      buf[idx + 4] = pb[3]; buf[idx + 5] = pb[2]; buf[idx + 6] = pb[1]; buf[idx + 7] = pb[0]
    }
    idx += 8

    view.setUint16(idx, nameId, true)
    idx += 2

    const ns = Math.round(startMs * 1e6)
    view.setUint32(idx, ns % 0x100000000, true)
    view.setUint32(idx + 4, Math.floor(ns / 0x100000000), true)
    idx += 8

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
  }

  /**
   * Queue a CreateSpanFull operation (Create + name + service + resource + type + start).
   *
   * @param {Uint8Array} spanId LE span ID
   * @param {Uint8Array|number[]} traceId BE Identifier buffer
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {string} service Service name
   * @param {string} resource Resource name
   * @param {string} type Span type
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpanFull (spanId, traceId, parentId, name, service, resource, type, startMs) {
    this.#ensureWasmViews()

    let idx = this._cqbIndex

    if (idx + 50 > CHANGE_QUEUE_BUFFER_SIZE) {
      this.flushChangeQueue()
      idx = this._cqbIndex
    }

    // Resolve all string IDs first (may trigger memory growth)
    const nameId = this.getStringId(name)
    const serviceId = this.getStringId(service)
    const resourceId = this.getStringId(resource)
    const typeId = this.getStringId(type)

    // Cache locals after all WASM calls
    const view = this._cqbView
    const buf = this._cqbBytes

    view.setUint16(idx, 34, true) // CreateSpanFull
    idx += 2
    buf.set(spanId, idx)
    idx += 8

    const tb = traceId._buffer ?? traceId
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

    if (parentId === null || parentId === undefined) {
      view.setUint32(idx, 0, true); view.setUint32(idx + 4, 0, true)
    } else {
      const pb = parentId._buffer ?? parentId
      buf[idx] = pb[7]; buf[idx + 1] = pb[6]; buf[idx + 2] = pb[5]; buf[idx + 3] = pb[4]
      buf[idx + 4] = pb[3]; buf[idx + 5] = pb[2]; buf[idx + 6] = pb[1]; buf[idx + 7] = pb[0]
    }
    idx += 8

    view.setUint16(idx, nameId, true); idx += 2
    view.setUint16(idx, serviceId, true); idx += 2
    view.setUint16(idx, resourceId, true); idx += 2
    view.setUint16(idx, typeId, true); idx += 2

    const ns = Math.round(startMs * 1e6)
    view.setUint32(idx, ns % 0x100000000, true)
    view.setUint32(idx + 4, Math.floor(ns / 0x100000000), true)
    idx += 8

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
  }

  /**
   * Queue multiple meta (string) tags using the BatchSetMeta opcode.
   * Single header, N key/value pairs. Written directly to WASM memory.
   *
   * @param {Uint8Array} spanId The span ID (little-endian)
   * @param {Array<[string, string]>} tags Array of [key, value] pairs
   */
  queueBatchMeta (spanId, tags) {
    if (tags.length === 0) return

    this.#ensureWasmViews()

    let idx = this._cqbIndex
    const needed = 14 + tags.length * 4

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

    view.setUint16(idx, 35, true) // BatchSetMeta
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, tags.length, true)
    idx += 4
    for (let i = 0; i < tags.length; i++) {
      view.setUint16(idx, ids[i * 2], true)
      idx += 2
      view.setUint16(idx, ids[i * 2 + 1], true)
      idx += 2
    }

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
  }

  /**
   * Queue multiple metric tags using the BatchSetMetric opcode.
   * Single header, N key/value pairs. Written directly to WASM memory.
   *
   * @param {Uint8Array} spanId The span ID (little-endian)
   * @param {Array<[string, number]>} tags Array of [key, value] pairs
   */
  queueBatchMetrics (spanId, tags) {
    if (tags.length === 0) return

    this.#ensureWasmViews()

    let idx = this._cqbIndex
    const needed = 14 + tags.length * 10

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

    view.setUint16(idx, 36, true) // BatchSetMetric
    idx += 2
    buf.set(spanId, idx)
    idx += 8
    view.setUint32(idx, tags.length, true)
    idx += 4
    for (let i = 0; i < tags.length; i++) {
      view.setUint16(idx, keyIds[i], true)
      idx += 2
      view.setFloat64(idx, tags[i][1], true)
      idx += 8
    }

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
  }

  /**
   * Flush spans to the Datadog agent.
   *
   * @param {Array<Uint8Array>} spanIds Array of span ID buffers (little-endian)
   * @param {boolean} [firstIsLocalRoot=true] Whether the first span is the local root
   * @returns {Promise<string>} Response from the agent
   */
  async flushSpans (spanIds, firstIsLocalRoot = true) {
    // Flush any pending change queue operations first
    this.flushChangeQueue()

    if (spanIds.length === 0) {
      return 'no spans to flush'
    }

    // Ensure flush buffer is large enough
    const requiredSize = spanIds.length * 8
    if (requiredSize > this._flushBuffer.length) {
      this._flushBuffer = Buffer.alloc(requiredSize)
    }

    // Write span IDs to flush buffer (already little-endian, just copy)
    let index = 0
    for (const spanId of spanIds) {
      this._flushBuffer.set(spanId, index)
      index += 8
    }

    try {
      this._state.prepareChunk(spanIds.length, firstIsLocalRoot, this._flushBuffer)
      const result = await this._state.sendPreparedChunk()
      return result
    } catch (e) {
      log.error('Error flushing spans to agent:', e)
      throw e
    }
  }

  /**
   * Ensure a span ID is a Uint8Array for passing to WASM.
   * WASM functions take &[u8] (JS Uint8Array) for span IDs.
   * @param {Uint8Array|number[]} buf The span ID buffer
   * @returns {Uint8Array}
   */
  #toUint8Array (buf) {
    if (buf instanceof Uint8Array) return buf
    return new Uint8Array(buf)
  }

  /**
   * Get a meta (string) attribute from a span.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getMetaAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getMetaAttr(this.#toUint8Array(spanId), key)
  }

  /**
   * Get a metric (numeric) attribute from a span.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getMetricAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getMetricAttr(this.#toUint8Array(spanId), key)
  }

  /**
   * Get the span name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The span name
   */
  getName (spanId) {
    this.flushChangeQueue()
    return this._state.getName(this.#toUint8Array(spanId))
  }

  /**
   * Get the service name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The service name
   */
  getServiceName (spanId) {
    this.flushChangeQueue()
    return this._state.getServiceName(this.#toUint8Array(spanId))
  }

  /**
   * Get the resource name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The resource name
   */
  getResourceName (spanId) {
    this.flushChangeQueue()
    return this._state.getResourceName(this.#toUint8Array(spanId))
  }

  /**
   * Get the span type.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The span type
   */
  getType (spanId) {
    this.flushChangeQueue()
    return this._state.getType(this.#toUint8Array(spanId))
  }

  /**
   * Get the error flag.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The error flag (0 or 1)
   */
  getError (spanId) {
    this.flushChangeQueue()
    return this._state.getError(this.#toUint8Array(spanId))
  }

  /**
   * Get the start time.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The start time in nanoseconds
   */
  getStart (spanId) {
    this.flushChangeQueue()
    return this._state.getStart(this.#toUint8Array(spanId))
  }

  /**
   * Get the duration.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The duration in nanoseconds
   */
  getDuration (spanId) {
    this.flushChangeQueue()
    return this._state.getDuration(this.#toUint8Array(spanId))
  }

  /**
   * Get a trace-level meta attribute.
   *
   * @param {Uint8Array|number[]} spanId A span ID buffer in the trace
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getTraceMetaAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetaAttr(this.#toUint8Array(spanId), key)
  }

  /**
   * Get a trace-level metric attribute.
   *
   * @param {Uint8Array|number[]} spanId A span ID buffer in the trace
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getTraceMetricAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetricAttr(this.#toUint8Array(spanId), key)
  }

  /**
   * Get the trace origin.
   *
   * @param {Uint8Array|number[]} spanId A span ID buffer in the trace
   * @returns {string|null} The trace origin or null
   */
  getTraceOrigin (spanId) {
    this.flushChangeQueue()
    return this._state.getTraceOrigin(this.#toUint8Array(spanId))
  }

  // Note: sample() is not available in the WASM pipeline module.
  // Sampling is handled by the JS-side priority sampler.
}

module.exports = NativeSpansInterface
