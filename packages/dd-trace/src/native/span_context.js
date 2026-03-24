'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const { OpCode } = require('./index')
const { BASE_SERVICE } = require('../../../../ext/tags')

/**
 * NativeSpanContext extends DatadogSpanContext to store span data in native Rust storage.
 *
 * This class overrides setTag() to sync tag writes immediately to native storage.
 * Code should use setTag()/getTag() accessors instead of accessing _tags directly.
 *
 * Key differences from DatadogSpanContext:
 * - Has a _nativeSpanId (byte buffer) for native operations
 * - setTag() syncs to native storage immediately
 */
// Tags that have dedicated OpCodes or special handling in syncTagToNative.
// Everything else is a plain meta string or metric number.
const SPECIAL_KEYS = new Set([
  'service.name', 'service', 'resource.name', 'span.type',
  'error', 'http.status_code', 'error.type',
])

// Symbol keys for internal backing storage — avoids Object.defineProperty deopt
// while keeping properties non-enumerable to external code.
const NAME_VALUE = Symbol('nameValue')
const NATIVE_READY = Symbol('nativeReady')

class NativeSpanContext extends DatadogSpanContext {
  #nativeSpans

  /**
   * @param {import('./native_spans')} nativeSpans - The NativeSpansInterface instance
   * @param {Object} props - SpanContext properties
   * @param {import('../id')} props.traceId - Trace ID
   * @param {import('../id')} props.spanId - Span ID
   * @param {import('../id')|null} [props.parentId] - Parent span ID
   * @param {Object} [props.sampling] - Sampling information
   * @param {Object} [props.baggageItems] - Baggage items
   * @param {Object} [props.trace] - Shared trace object
   * @param {Object} [props.tracestate] - W3C tracestate
   * @param {string} [props.tracerService] - Tracer's configured service name (for BASE_SERVICE)
   */
  constructor (nativeSpans, props) {
    // NAME_VALUE and NATIVE_READY are set before super() so the _name setter
    // (which fires during super(props) when parent assigns this._name) can
    // store the value without throwing.
    super(props)

    this.#nativeSpans = nativeSpans

    // Store span ID as little-endian Uint8Array to avoid per-operation byte
    // reversal when writing to the WASM change buffer (which expects LE).
    const beBuf = props.spanId.toBuffer()
    const leId = new Uint8Array(8)
    leId[0] = beBuf[7]
    leId[1] = beBuf[6]
    leId[2] = beBuf[5]
    leId[3] = beBuf[4]
    leId[4] = beBuf[3]
    leId[5] = beBuf[2]
    leId[6] = beBuf[1]
    leId[7] = beBuf[0]
    this._nativeSpanId = leId
    this._tracerService = props.tracerService // Store for BASE_SERVICE check
    this[NATIVE_READY] = true
  }

  // Class-level getter/setter for _name — intercepts writes to sync to native.
  // Uses Symbol-keyed backing store instead of Object.defineProperty to preserve
  // V8 hidden class optimization (all instances share the same shape).
  get _name () {
    return this[NAME_VALUE]
  }

  set _name (value) {
    this[NAME_VALUE] = value
    if (this[NATIVE_READY]) {
      this._syncNameToNative(value)
    }
  }

  /**
   * Set a tag value and sync to native storage.
   * @param {string|Symbol} key - Tag key
   * @param {*} value - Tag value
   */
  setTag (key, value) {
    // Store in JS cache via parent (preserve original type)
    super.setTag(key, value)

    // Symbol keys are for internal JS use only (e.g., IGNORE_OTEL_ERROR)
    if (typeof key === 'symbol') return
    if (value === undefined || value === null) return

    // Fast path: non-special string tags skip the switch dispatch entirely
    if (typeof value === 'string' && !SPECIAL_KEYS.has(key)) {
      this.#nativeSpans.queueOp(
        OpCode.SetMetaAttr,
        this._nativeSpanId,
        key,
        value,
      )
      return
    }

    // Fast path: non-special number tags
    if (typeof value === 'number' && !SPECIAL_KEYS.has(key)) {
      this.#nativeSpans.queueOp(
        OpCode.SetMetricAttr,
        this._nativeSpanId,
        key,
        ['f64', value],
      )
      return
    }

    // Sync to native storage (special tags + booleans)
    this.#syncTagToNative(key, value)
  }

  /**
   * Sync a batch of initial tags to native storage efficiently.
   *
   * Separates special tags (service.name, error, etc.) from plain meta/metric
   * tags. Special tags go through the normal setTag path. Plain tags are
   * batched into a single queueBatchMeta/queueBatchMetrics call, avoiding
   * per-tag queueOp overhead.
   *
   * @param {Object} tags - Tag object from span fields
   */
  syncInitialTags (tags) {
    const metaBatch = []
    const metricBatch = []

    for (const key in tags) {
      const value = tags[key]
      if (value === undefined || value === null) continue

      // Store in JS cache
      super.setTag(key, value)

      if (typeof key === 'symbol') continue

      if (SPECIAL_KEYS.has(key)) {
        // Special tags need individual handling (dedicated opcodes, side effects)
        this.#syncTagToNative(key, value)
      } else if (typeof value === 'number') {
        metricBatch.push([key, value])
      } else if (typeof value === 'boolean') {
        metricBatch.push([key, value ? 1 : 0])
      } else {
        metaBatch.push([key, String(value)])
      }
    }

    if (metaBatch.length > 0) {
      this.#nativeSpans.queueBatchMeta(this._nativeSpanId, metaBatch)
    }
    if (metricBatch.length > 0) {
      this.#nativeSpans.queueBatchMetrics(this._nativeSpanId, metricBatch)
    }
  }

  /**
   * Sync tags to native storage only (JS cache already populated).
   * Separates special tags from plain meta/metric tags and batches the latter.
   *
   * @param {Object} tags - Tag object to sync
   */
  syncToNativeOnly (tags) {
    const metaBatch = []
    const metricBatch = []

    for (const key in tags) {
      const value = tags[key]
      if (value === undefined || value === null) continue
      if (typeof key === 'symbol') continue

      if (SPECIAL_KEYS.has(key)) {
        this.#syncTagToNative(key, value)
      } else if (typeof value === 'number') {
        metricBatch.push([key, value])
      } else if (typeof value === 'boolean') {
        metricBatch.push([key, value ? 1 : 0])
      } else {
        metaBatch.push([key, String(value)])
      }
    }

    if (metaBatch.length > 0) {
      this.#nativeSpans.queueBatchMeta(this._nativeSpanId, metaBatch)
    }
    if (metricBatch.length > 0) {
      this.#nativeSpans.queueBatchMetrics(this._nativeSpanId, metricBatch)
    }
  }

  /**
   * Sync a tag value to native storage.
   * @param {string} key - Tag key
   * @param {*} value - Tag value
   */
  #syncTagToNative (key, value) {
    if (value === undefined || value === null) {
      return
    }

    // Handle special span properties that have dedicated OpCodes
    switch (key) {
      case 'service.name':
        this.#nativeSpans.queueOp(
          OpCode.SetServiceName,
          this._nativeSpanId,
          String(value)
        )
        // Set _dd.base_service when span's service differs from tracer's configured service
        // This matches the behavior in span_format.js
        if (this._tracerService && String(value).toLowerCase() !== this._tracerService.toLowerCase()) {
          super.setTag(BASE_SERVICE, this._tracerService)
          this.#nativeSpans.queueOp(
            OpCode.SetMetaAttr,
            this._nativeSpanId,
            BASE_SERVICE,
            String(this._tracerService)
          )
        }
        return

      case 'service':
        // Skip - this is a duplicate of service.name from tagger expansion
        // The service is already set via SetServiceName when service.name is set
        return

      case 'resource.name':
        this.#nativeSpans.queueOp(
          OpCode.SetResourceName,
          this._nativeSpanId,
          String(value)
        )
        return

      case 'span.type':
        this.#nativeSpans.queueOp(
          OpCode.SetType,
          this._nativeSpanId,
          String(value)
        )
        return

      case 'error':
        // fs.operation spans have special handling - errors don't set the span error field
        // This matches the behavior in span_format.js which skips extractError for fs.operation
        if (this._name === 'fs.operation') {
          // Store the error info in meta tags but don't set span.error = 1
          // The error details are still accessible via meta tags
          return
        }
        this.#nativeSpans.queueOp(
          OpCode.SetError,
          this._nativeSpanId,
          ['i32', value ? 1 : 0]
        )
        // If value is an Error object, also extract error.type, error.message, error.stack
        // This matches the behavior in span_format.js extractError()
        if (value instanceof Error) {
          if (value.name) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.type', String(value.name))
          }
          if (value.message || value.code) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.message', String(value.message || value.code))
          }
          if (value.stack) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.stack', String(value.stack))
          }
        }
        return

      // HACK: http.status_code must be stored as string in meta, not number in metrics
      // This matches the behavior in span_format.js
      case 'http.status_code':
        this.#nativeSpans.queueOp(
          OpCode.SetMetaAttr,
          this._nativeSpanId,
          key,
          String(value)
        )
        return

      // When error.type is set, also set span.error = 1
      // This matches the behavior in span_format.js where ERROR_TYPE triggers formattedSpan.error = 1
      // (except for fs.operation spans which have special error handling)
      case 'error.type':
        if (this._name !== 'fs.operation') {
          this.#nativeSpans.queueOp(
            OpCode.SetError,
            this._nativeSpanId,
            ['i32', 1]
          )
        }
        // Fall through to add the meta tag
        this.#nativeSpans.queueOp(
          OpCode.SetMetaAttr,
          this._nativeSpanId,
          key,
          String(value)
        )
        return

      default:
        // Regular tags go to meta (string) or metrics (number)
        if (typeof value === 'number') {
          this.#nativeSpans.queueOp(
            OpCode.SetMetricAttr,
            this._nativeSpanId,
            key,
            ['f64', value]
          )
        } else if (typeof value === 'boolean') {
          // Booleans are stored as metrics (0 or 1)
          this.#nativeSpans.queueOp(
            OpCode.SetMetricAttr,
            this._nativeSpanId,
            key,
            ['f64', value ? 1 : 0]
          )
        } else {
          this.#nativeSpans.queueOp(
            OpCode.SetMetaAttr,
            this._nativeSpanId,
            key,
            String(value)
          )
        }
    }
  }

  /**
   * Set the name locally without syncing to native storage.
   * Used during construction when CreateSpan already set the name natively.
   * @param {string} name - Span name
   */
  _setNameLocal (name) {
    this[NAME_VALUE] = name
  }

  /**
   * Sync the span name to native storage.
   * Called from NativeDatadogSpan.
   * @param {string} name - Span name
   */
  _syncNameToNative (name) {
    this.#nativeSpans.queueOp(
      OpCode.SetName,
      this._nativeSpanId,
      String(name)
    )
  }

  /**
   * Set a trace-level tag (stored on the trace, not the span).
   * @param {string} key - Tag key
   * @param {*} value - Tag value
   */
  _setTraceTag (key, value) {
    // Update the shared trace tags object
    this._trace.tags[key] = value

    // Also sync to native storage
    if (typeof value === 'number') {
      this.#nativeSpans.queueOp(
        OpCode.SetTraceMetricsAttr,
        this._nativeSpanId,
        key,
        ['f64', value]
      )
    } else {
      this.#nativeSpans.queueOp(
        OpCode.SetTraceMetaAttr,
        this._nativeSpanId,
        key,
        String(value)
      )
    }
  }

  /**
   * Set the trace origin.
   * @param {string} origin - Trace origin
   */
  _setTraceOrigin (origin) {
    this.#nativeSpans.queueOp(
      OpCode.SetTraceOrigin,
      this._nativeSpanId,
      String(origin)
    )
  }

  /**
   * Get the native span ID as a byte buffer.
   * @returns {Uint8Array|number[]}
   */
  get nativeSpanId () {
    return this._nativeSpanId
  }
}

module.exports = NativeSpanContext
