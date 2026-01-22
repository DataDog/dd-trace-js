'use strict'

const { NativeSpanState, OpCode } = require('./index')
const log = require('../log')

// Default buffer sizes
const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024 // 64KB
const STRING_TABLE_INPUT_BUFFER_SIZE = 10 * 1024 // 10KB
const SAMPLING_BUFFER_SIZE = 1024 // 1KB
const FLUSH_BUFFER_SIZE = 10 * 1024 // 10KB

// Pre-compute BigInt versions of opcodes to avoid allocation in hot path
// Index by opcode number for O(1) lookup
const OpCodeBigInt = []
if (OpCode) {
  for (const value of Object.values(OpCode)) {
    OpCodeBigInt[value] = BigInt(value)
  }
}

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

    // Create DataView for efficient typed writes
    this._cqbView = new DataView(this._changeQueueBuffer.buffer, this._changeQueueBuffer.byteOffset)

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
   * @param {Uint8Array|number[]} spanId The span ID as a byte buffer (big-endian)
   * @param {...(string|Array)} args Operation arguments
   */
  queueOp (op, spanId, ...args) {
    // Check if Rust flushed the queue (wrote 0 to count position)
    if (this._cqbView.getUint32(0, true) === 0 && this._cqbCount > 0) {
      this._cqbIndex = 8
      this._cqbCount = 0
    }

    // Check if we have enough space (rough estimate)
    const estimatedSize = 16 + args.length * 16 // op + spanId + args
    if (this._cqbIndex + estimatedSize > this._changeQueueBuffer.length) {
      // Buffer full, flush first
      this.flushChangeQueue()
    }

    const buf = this._changeQueueBuffer
    const view = this._cqbView
    let idx = this._cqbIndex

    // Write opcode (use pre-computed BigInt)
    view.setBigUint64(idx, OpCodeBigInt[op] ?? BigInt(op), true)
    idx += 8

    // Write span ID (convert from big-endian buffer to little-endian)
    buf[idx] = spanId[7]
    buf[idx + 1] = spanId[6]
    buf[idx + 2] = spanId[5]
    buf[idx + 3] = spanId[4]
    buf[idx + 4] = spanId[3]
    buf[idx + 5] = spanId[2]
    buf[idx + 6] = spanId[1]
    buf[idx + 7] = spanId[0]
    idx += 8

    // Write arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (typeof arg === 'string') {
        const stringId = this.getStringId(arg)
        view.setUint32(idx, stringId, true)
        idx += 4
      } else {
        const type = arg[0]
        const value = arg[1]
        switch (type) {
          case 'id64': {
            // value is an Identifier, its _buffer (big-endian bytes), or null
            if (value === null || value === undefined) {
              // Write 8 zero bytes
              view.setBigUint64(idx, 0n, true)
            } else {
              const b = value._buffer ?? value
              // Write 8 bytes as little-endian (reverse big-endian buffer)
              buf[idx] = b[7]
              buf[idx + 1] = b[6]
              buf[idx + 2] = b[5]
              buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]
              buf[idx + 5] = b[2]
              buf[idx + 6] = b[1]
              buf[idx + 7] = b[0]
            }
            idx += 8
            break
          }
          case 'id128': {
            // value is an Identifier or its _buffer (big-endian bytes)
            const b = value._buffer ?? value
            if (b.length > 8) {
              // 128-bit: write low 8 bytes as LE, then high 8 bytes as LE
              buf[idx] = b[15]
              buf[idx + 1] = b[14]
              buf[idx + 2] = b[13]
              buf[idx + 3] = b[12]
              buf[idx + 4] = b[11]
              buf[idx + 5] = b[10]
              buf[idx + 6] = b[9]
              buf[idx + 7] = b[8]
              idx += 8
              buf[idx] = b[7]
              buf[idx + 1] = b[6]
              buf[idx + 2] = b[5]
              buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]
              buf[idx + 5] = b[2]
              buf[idx + 6] = b[1]
              buf[idx + 7] = b[0]
              idx += 8
            } else {
              // 64-bit: write as LE, high part is zero
              buf[idx] = b[7]
              buf[idx + 1] = b[6]
              buf[idx + 2] = b[5]
              buf[idx + 3] = b[4]
              buf[idx + 4] = b[3]
              buf[idx + 5] = b[2]
              buf[idx + 6] = b[1]
              buf[idx + 7] = b[0]
              idx += 8
              // High part is zero
              view.setBigUint64(idx, 0n, true)
              idx += 8
            }
            break
          }
          case 'u64':
            view.setBigUint64(idx, value, true)
            idx += 8
            break
          case 'i64':
            view.setBigInt64(idx, value, true)
            idx += 8
            break
          case 'ns': {
            // Nanoseconds from milliseconds - avoid BigInt allocation
            // Split into low and high 32-bit parts using Math ops (bitwise only works up to 2^32)
            const ns = Math.round(value * 1e6)
            const low = ns % 0x100000000
            const high = Math.floor(ns / 0x100000000)
            view.setUint32(idx, low, true)
            view.setUint32(idx + 4, high, true)
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
          default:
            throw new Error(`Unsupported argument type: ${type}`)
        }
      }
    }

    this._cqbIndex = idx

    // Update count (write as two 32-bit values to avoid BigInt allocation)
    this._cqbCount++
    view.setUint32(0, this._cqbCount, true)
    view.setUint32(4, 0, true) // high 32 bits are always 0
  }

  /**
   * Flush spans to the Datadog agent.
   *
   * @param {Array<Uint8Array|number[]>} spanIds Array of span ID buffers (big-endian)
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

    // Write span IDs to flush buffer (convert from big-endian to little-endian)
    let index = 0
    for (const spanId of spanIds) {
      for (let i = 0; i < 8; i++) {
        this._flushBuffer[index + i] = spanId[7 - i]
      }
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
   * Convert a big-endian span ID buffer to BigInt for native calls.
   * @param {Uint8Array|number[]} buf The span ID buffer
   * @returns {bigint}
   */
  #bufferToBigInt (buf) {
    return (BigInt(buf[0]) << 56n) |
           (BigInt(buf[1]) << 48n) |
           (BigInt(buf[2]) << 40n) |
           (BigInt(buf[3]) << 32n) |
           (BigInt(buf[4]) << 24n) |
           (BigInt(buf[5]) << 16n) |
           (BigInt(buf[6]) << 8n) |
           BigInt(buf[7])
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
    return this._state.getMetaAttr(this.#bufferToBigInt(spanId), key)
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
    return this._state.getMetricAttr(this.#bufferToBigInt(spanId), key)
  }

  /**
   * Get the span name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The span name
   */
  getName (spanId) {
    this.flushChangeQueue()
    return this._state.getName(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the service name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The service name
   */
  getServiceName (spanId) {
    this.flushChangeQueue()
    return this._state.getServiceName(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the resource name.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The resource name
   */
  getResourceName (spanId) {
    this.flushChangeQueue()
    return this._state.getResourceName(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the span type.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {string} The span type
   */
  getType (spanId) {
    this.flushChangeQueue()
    return this._state.getType(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the error flag.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The error flag (0 or 1)
   */
  getError (spanId) {
    this.flushChangeQueue()
    return this._state.getError(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the start time.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The start time in nanoseconds
   */
  getStart (spanId) {
    this.flushChangeQueue()
    return this._state.getStart(this.#bufferToBigInt(spanId))
  }

  /**
   * Get the duration.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer
   * @returns {number} The duration in nanoseconds
   */
  getDuration (spanId) {
    this.flushChangeQueue()
    return this._state.getDuration(this.#bufferToBigInt(spanId))
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
    return this._state.getTraceMetaAttr(this.#bufferToBigInt(spanId), key)
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
    return this._state.getTraceMetricAttr(this.#bufferToBigInt(spanId), key)
  }

  /**
   * Get the trace origin.
   *
   * @param {Uint8Array|number[]} spanId A span ID buffer in the trace
   * @returns {string|null} The trace origin or null
   */
  getTraceOrigin (spanId) {
    this.flushChangeQueue()
    return this._state.getTraceOrigin(this.#bufferToBigInt(spanId))
  }

  /**
   * Perform priority sampling for a span/trace.
   *
   * This delegates to the native Rust sampling implementation which
   * makes the sampling decision based on configured rules and rates.
   *
   * @param {Uint8Array|number[]} spanId The span ID buffer to sample
   * @returns {number} The sampling priority (-1=AUTO_REJECT, 0=AUTO_KEEP, 1=USER_REJECT, 2=USER_KEEP)
   */
  sample (spanId) {
    // Flush pending changes so native has current span state
    this.flushChangeQueue()

    // Write span ID to sampling buffer as u64 LE (convert from big-endian)
    for (let i = 0; i < 8; i++) {
      this._samplingBuffer[i] = spanId[7 - i]
    }

    return this._state.sample()
  }
}

module.exports = NativeSpansInterface
