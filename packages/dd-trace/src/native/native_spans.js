'use strict'

const { NativeSpanState, OpCode } = require('./index')
const log = require('../log')

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 64 * 1024 // 64KB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const SAMPLING_BUFFER_SIZE = 1024 // 1KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB

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
   */
  constructor (options) {
    if (!NativeSpanState) {
      throw new Error('Native spans module is not available')
    }

    // Store options for potential re-initialization
    this._options = {
      tracerVersion: options.tracerVersion,
      lang: options.lang || 'nodejs',
      langVersion: options.langVersion || process.version,
      langInterpreter: options.langInterpreter || 'v8',
      pid: options.pid ?? process.pid,
      tracerService: options.tracerService
    }

    // Allocate shared buffers
    this._changeQueueBuffer = Buffer.alloc(CHANGE_QUEUE_BUFFER_SIZE)
    this._stringTableInputBuffer = Buffer.alloc(STRING_TABLE_INPUT_BUFFER_SIZE)
    this._samplingBuffer = Buffer.alloc(SAMPLING_BUFFER_SIZE)
    this._flushBuffer = Buffer.alloc(FLUSH_BUFFER_SIZE)

    // Change queue buffer state
    // First 8 bytes store the count of operations
    this._cqbIndex = 8
    this._cqbCount = 0

    // String table state
    this._stringMap = new Map()
    this._stringIdCounter = 0

    // Initialize the native state
    this._state = new NativeSpanState(
      options.agentUrl,
      this._options.tracerVersion,
      this._options.lang,
      this._options.langVersion,
      this._options.langInterpreter,
      this._changeQueueBuffer,
      this._stringTableInputBuffer,
      this._options.pid,
      this._options.tracerService,
      this._samplingBuffer
    )

    log.debug('Native spans interface initialized')
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

    // Reinitialize native state with new URL
    this._state = new NativeSpanState(
      url,
      this._options.tracerVersion,
      this._options.lang,
      this._options.langVersion,
      this._options.langInterpreter,
      this._changeQueueBuffer,
      this._stringTableInputBuffer,
      this._options.pid,
      this._options.tracerService,
      this._samplingBuffer
    )

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
    this._changeQueueBuffer.fill(0)
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
    this._state.stringTableInsertOne(id, str)
    return id
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
   * The change buffer uses a binary protocol:
   * [Count:u64][OpCode:u64, SpanId:u64, Args...]...
   *
   * @param {number} op The OpCode value
   * @param {bigint} spanId The span ID (as BigInt)
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, spanId, ...args) {
    // Check if Rust flushed the queue (wrote 0 to count position)
    if (this._changeQueueBuffer.readBigUInt64LE(0) === 0n && this._cqbCount > 0) {
      this._cqbIndex = 8
      this._cqbCount = 0
    }

    // Check if we have enough space (rough estimate)
    const estimatedSize = 16 + args.length * 16 // op + spanId + args
    if (this._cqbIndex + estimatedSize > this._changeQueueBuffer.length) {
      // Buffer full, flush first
      this.flushChangeQueue()
    }

    // Write opcode
    this._changeQueueBuffer.writeBigUInt64LE(BigInt(op), this._cqbIndex)
    this._cqbIndex += 8

    // Write span ID
    this._changeQueueBuffer.writeBigUInt64LE(spanId, this._cqbIndex)
    this._cqbIndex += 8

    // Write arguments
    for (const arg of args) {
      if (typeof arg === 'string') {
        const stringId = this.getStringId(arg)
        this._changeQueueBuffer.writeUInt32LE(stringId, this._cqbIndex)
        this._cqbIndex += 4
      } else if (Array.isArray(arg)) {
        const [type, value] = arg
        switch (type) {
          case 'u64':
            this._changeQueueBuffer.writeBigUInt64LE(value, this._cqbIndex)
            this._cqbIndex += 8
            break
          case 'u128':
            // u128 is passed as array of two BigInts [high, low]
            // For little-endian u128, low bytes come first, then high bytes
            this._changeQueueBuffer.writeBigUInt64LE(value[1], this._cqbIndex)  // low part first
            this._cqbIndex += 8
            this._changeQueueBuffer.writeBigUInt64LE(value[0], this._cqbIndex)  // high part second
            this._cqbIndex += 8
            break
          case 'i64':
            this._changeQueueBuffer.writeBigInt64LE(value, this._cqbIndex)
            this._cqbIndex += 8
            break
          case 'i32':
            this._changeQueueBuffer.writeInt32LE(value, this._cqbIndex)
            this._cqbIndex += 4
            break
          case 'f64':
            this._changeQueueBuffer.writeDoubleLE(value, this._cqbIndex)
            this._cqbIndex += 8
            break
          default:
            throw new Error(`Unsupported argument type: ${type}`)
        }
      } else {
        throw new Error(`Invalid argument: ${arg}`)
      }
    }

    // Update count
    this._cqbCount++
    this._changeQueueBuffer.writeBigUInt64LE(BigInt(this._cqbCount), 0)
  }

  /**
   * Flush spans to the Datadog agent.
   *
   * @param {bigint[]} spanIds Array of span IDs to flush
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

    // Write span IDs to flush buffer
    let index = 0
    for (const spanId of spanIds) {
      this._flushBuffer.writeBigUInt64LE(spanId, index)
      index += 8
    }

    try {
      const result = await this._state.flushChunk(spanIds.length, firstIsLocalRoot, this._flushBuffer)
      return result
    } catch (e) {
      log.error('Error flushing spans to agent:', e)
      throw e
    }
  }

  /**
   * Get a meta (string) attribute from a span.
   *
   * @param {bigint} spanId The span ID
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getMetaAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getMetaAttr(spanId, key)
  }

  /**
   * Get a metric (numeric) attribute from a span.
   *
   * @param {bigint} spanId The span ID
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getMetricAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getMetricAttr(spanId, key)
  }

  /**
   * Get the span name.
   *
   * @param {bigint} spanId The span ID
   * @returns {string} The span name
   */
  getName (spanId) {
    this.flushChangeQueue()
    return this._state.getName(spanId)
  }

  /**
   * Get the service name.
   *
   * @param {bigint} spanId The span ID
   * @returns {string} The service name
   */
  getServiceName (spanId) {
    this.flushChangeQueue()
    return this._state.getServiceName(spanId)
  }

  /**
   * Get the resource name.
   *
   * @param {bigint} spanId The span ID
   * @returns {string} The resource name
   */
  getResourceName (spanId) {
    this.flushChangeQueue()
    return this._state.getResourceName(spanId)
  }

  /**
   * Get the span type.
   *
   * @param {bigint} spanId The span ID
   * @returns {string} The span type
   */
  getType (spanId) {
    this.flushChangeQueue()
    return this._state.getType(spanId)
  }

  /**
   * Get the error flag.
   *
   * @param {bigint} spanId The span ID
   * @returns {number} The error flag (0 or 1)
   */
  getError (spanId) {
    this.flushChangeQueue()
    return this._state.getError(spanId)
  }

  /**
   * Get the start time.
   *
   * @param {bigint} spanId The span ID
   * @returns {number} The start time in nanoseconds
   */
  getStart (spanId) {
    this.flushChangeQueue()
    return this._state.getStart(spanId)
  }

  /**
   * Get the duration.
   *
   * @param {bigint} spanId The span ID
   * @returns {number} The duration in nanoseconds
   */
  getDuration (spanId) {
    this.flushChangeQueue()
    return this._state.getDuration(spanId)
  }

  /**
   * Get a trace-level meta attribute.
   *
   * @param {bigint} spanId A span ID in the trace
   * @param {string} key The attribute key
   * @returns {string|null} The attribute value or null
   */
  getTraceMetaAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetaAttr(spanId, key)
  }

  /**
   * Get a trace-level metric attribute.
   *
   * @param {bigint} spanId A span ID in the trace
   * @param {string} key The attribute key
   * @returns {number|null} The attribute value or null
   */
  getTraceMetricAttr (spanId, key) {
    this.flushChangeQueue()
    return this._state.getTraceMetricAttr(spanId, key)
  }

  /**
   * Get the trace origin.
   *
   * @param {bigint} spanId A span ID in the trace
   * @returns {string|null} The trace origin or null
   */
  getTraceOrigin (spanId) {
    this.flushChangeQueue()
    return this._state.getTraceOrigin(spanId)
  }

  /**
   * Perform priority sampling for a span/trace.
   *
   * This delegates to the native Rust sampling implementation which
   * makes the sampling decision based on configured rules and rates.
   *
   * @param {bigint} spanId The span ID to sample
   * @returns {number} The sampling priority (-1=AUTO_REJECT, 0=AUTO_KEEP, 1=USER_REJECT, 2=USER_KEEP)
   */
  sample (spanId) {
    // Flush pending changes so native has current span state
    this.flushChangeQueue()

    // Write span ID to sampling buffer as u64 LE (required by native side)
    this._samplingBuffer.writeBigUInt64LE(spanId, 0)

    return this._state.sample()
  }
}

module.exports = NativeSpansInterface
