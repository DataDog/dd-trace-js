'use strict'

const { WasmSpanState, OpCode, wasmMemory } = require('./index')
const log = require('../log')

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024 // 8MB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB

// OpCode values are small integers (0-12), written as u64 LE via two u32 writes.

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
    // First 8 bytes store the count of operations
    this._cqbIndex = 8
    this._cqbCount = 0

    // Slot allocator state
    this._nextSlot = 0
    this._freeSlots = []

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
    this._cqbIndex = 8
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
   * Allocate a slot index for a new span.
   * Reuses freed slots when available, otherwise increments the counter.
   * @returns {number} The allocated slot index
   */
  allocSlot () {
    if (this._freeSlots.length > 0) return this._freeSlots.pop()
    return this._nextSlot++
  }

  /**
   * Return slot indices to the free list after spans are flushed.
   * @param {Array<number>} slots Array of slot indices to free
   */
  freeSlots (slots) {
    for (let i = 0; i < slots.length; i++) this._freeSlots.push(slots[i])
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
   * @param {number} slotIndex The slot index (u32)
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, slotIndex, ...args) {
    this.#ensureWasmViews()

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

    view.setUint32(idx, op, true)
    view.setUint32(idx + 4, 0, true)
    idx += 8
    view.setUint32(idx, slotIndex, true)
    idx += 4

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
    view.setUint32(4, 0, true)
  }

  /**
   * Increment the op count and write it to WASM memory.
   * Checks for detach first since a getStringId call may have grown memory.
   */
  #updateCount () {
    this.#checkDetach()
    this._cqbCount++
    this._cqbView.setUint32(0, this._cqbCount, true)
    this._cqbView.setUint32(4, 0, true)
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
      this._cqbIndex = 8
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
   * @param {number} slotIndex The slot index (u32)
   * @param {Uint8Array} spanId LE span ID
   * @param {Uint8Array|number[]} traceId BE Identifier buffer (8 or 16 bytes)
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpan (slotIndex, spanId, traceId, parentId, name, startMs) {
    this.#ensureWasmViews()

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

    view.setUint32(idx, 13, true); view.setUint32(idx + 4, 0, true)
    idx += 8
    view.setUint32(idx, slotIndex, true)
    idx += 4
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

    view.setUint32(idx, nameId, true)
    idx += 4

    const ns = Math.round(startMs * 1e6)
    view.setUint32(idx, ns % 0x100000000, true)
    view.setUint32(idx + 4, Math.floor(ns / 0x100000000), true)
    idx += 8

    this._cqbIndex = idx
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true)
  }

  /**
   * Queue a CreateSpanFull operation (Create + name + service + resource + type + start).
   *
   * @param {number} slotIndex The slot index (u32)
   * @param {Uint8Array} spanId LE span ID
   * @param {Uint8Array|number[]} traceId BE Identifier buffer
   * @param {Uint8Array|number[]|null} parentId BE Identifier buffer or null
   * @param {string} name Span name
   * @param {string} service Service name
   * @param {string} resource Resource name
   * @param {string} type Span type
   * @param {number} startMs Start time in milliseconds
   */
  queueCreateSpanFull (slotIndex, spanId, traceId, parentId, name, service, resource, type, startMs) {
    this.#ensureWasmViews()

    let idx = this._cqbIndex

    if (idx + 80 > CHANGE_QUEUE_BUFFER_SIZE) {
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

    view.setUint32(idx, 14, true); view.setUint32(idx + 4, 0, true)
    idx += 8
    view.setUint32(idx, slotIndex, true)
    idx += 4
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

    view.setUint32(idx, nameId, true); idx += 4
    view.setUint32(idx, serviceId, true); idx += 4
    view.setUint32(idx, resourceId, true); idx += 4
    view.setUint32(idx, typeId, true); idx += 4

    const ns = Math.round(startMs * 1e6)
    view.setUint32(idx, ns % 0x100000000, true)
    view.setUint32(idx + 4, Math.floor(ns / 0x100000000), true)
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
   * @param {number} slotIndex The slot index (u32)
   * @param {Array<[string, string]>} tags Array of [key, value] pairs
   */
  queueBatchMeta (slotIndex, tags) {
    if (tags.length === 0) return

    this.#ensureWasmViews()

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

    view.setUint32(idx, 15, true); view.setUint32(idx + 4, 0, true)
    idx += 8
    view.setUint32(idx, slotIndex, true)
    idx += 4
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
   * @param {number} slotIndex The slot index (u32)
   * @param {Array<[string, number]>} tags Array of [key, value] pairs
   */
  queueBatchMetrics (slotIndex, tags) {
    if (tags.length === 0) return

    this.#ensureWasmViews()

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

    view.setUint32(idx, 16, true); view.setUint32(idx + 4, 0, true)
    idx += 8
    view.setUint32(idx, slotIndex, true)
    idx += 4
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
   * Flush spans to the Datadog agent.
   *
   * @param {Array<number>} slots Array of u32 slot indices
   * @param {boolean} [firstIsLocalRoot=true] Whether the first span is the local root
   * @returns {Promise<string>} Response from the agent
   */
  async flushSpans (slots, firstIsLocalRoot = true) {
    // Flush any pending change queue operations first
    this.flushChangeQueue()

    if (slots.length === 0) {
      return 'no spans to flush'
    }

    // Ensure flush buffer is large enough
    const requiredSize = slots.length * 4
    if (requiredSize > this._flushBuffer.length) {
      this._flushBuffer = Buffer.alloc(requiredSize)
    }

    // Write slot indices to flush buffer as u32 LE
    let index = 0
    for (const slot of slots) {
      this._flushBuffer.writeUInt32LE(slot, index)
      index += 4
    }

    try {
      this._state.prepareChunk(slots.length, firstIsLocalRoot, this._flushBuffer)
      const result = await this._state.sendPreparedChunk()
      return result
    } catch (e) {
      log.error('Error flushing spans to agent:', e)
      throw e
    }
  }

  /**
   * Get a meta (string) attribute from a span.
   *
   * @param {number} slotIndex The slot index
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getMetaAttr (slotIndex, key) {
    this.flushChangeQueue()
    return this._state.getMetaAttr(slotIndex, key)
  }

  /**
   * Get a metric (numeric) attribute from a span.
   *
   * @param {number} slotIndex The slot index
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getMetricAttr (slotIndex, key) {
    this.flushChangeQueue()
    return this._state.getMetricAttr(slotIndex, key)
  }

  /**
   * Get the span name.
   *
   * @param {number} slotIndex The slot index
   * @returns {string} The span name
   */
  getName (slotIndex) {
    this.flushChangeQueue()
    return this._state.getName(slotIndex)
  }

  /**
   * Get the service name.
   *
   * @param {number} slotIndex The slot index
   * @returns {string} The service name
   */
  getServiceName (slotIndex) {
    this.flushChangeQueue()
    return this._state.getServiceName(slotIndex)
  }

  /**
   * Get the resource name.
   *
   * @param {number} slotIndex The slot index
   * @returns {string} The resource name
   */
  getResourceName (slotIndex) {
    this.flushChangeQueue()
    return this._state.getResourceName(slotIndex)
  }

  /**
   * Get the span type.
   *
   * @param {number} slotIndex The slot index
   * @returns {string} The span type
   */
  getType (slotIndex) {
    this.flushChangeQueue()
    return this._state.getType(slotIndex)
  }

  /**
   * Get the error flag.
   *
   * @param {number} slotIndex The slot index
   * @returns {number} The error flag (0 or 1)
   */
  getError (slotIndex) {
    this.flushChangeQueue()
    return this._state.getError(slotIndex)
  }

  /**
   * Get the start time.
   *
   * @param {number} slotIndex The slot index
   * @returns {number} The start time in nanoseconds
   */
  getStart (slotIndex) {
    this.flushChangeQueue()
    return this._state.getStart(slotIndex)
  }

  /**
   * Get the duration.
   *
   * @param {number} slotIndex The slot index
   * @returns {number} The duration in nanoseconds
   */
  getDuration (slotIndex) {
    this.flushChangeQueue()
    return this._state.getDuration(slotIndex)
  }

  /**
   * Get a trace-level meta attribute.
   *
   * @param {number} slotIndex A slot index for a span in the trace
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getTraceMetaAttr (slotIndex, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetaAttr(slotIndex, key)
  }

  /**
   * Get a trace-level metric attribute.
   *
   * @param {number} slotIndex A slot index for a span in the trace
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getTraceMetricAttr (slotIndex, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetricAttr(slotIndex, key)
  }

  /**
   * Get the trace origin.
   *
   * @param {number} slotIndex A slot index for a span in the trace
   * @returns {string|null} The trace origin or null
   */
  getTraceOrigin (slotIndex) {
    this.flushChangeQueue()
    return this._state.getTraceOrigin(slotIndex)
  }

  // Note: sample() is not available in the WASM pipeline module.
  // Sampling is handled by the JS-side priority sampler.
}

module.exports = NativeSpansInterface
