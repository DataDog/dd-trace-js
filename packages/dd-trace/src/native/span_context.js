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
 * - Has a _nativeSpanId (BigInt) for native operations
 * - setTag() syncs to native storage immediately
 */
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
    super(props)

    this.#nativeSpans = nativeSpans
    this._nativeSpanId = props.spanId.toBigInt()
    this._tracerService = props.tracerService // Store for BASE_SERVICE check

    // Override _name property with getter/setter to sync name changes to native storage.
    // This is needed because web.js setFramework() directly sets span.context()._name.
    // We do this after super() to avoid issues with private field access during construction.
    let nameValue = this._name // Get the value set by super()
    Object.defineProperty(this, '_name', {
      get: () => nameValue,
      set: (value) => {
        nameValue = value
        this._syncNameToNative(value)
      },
      configurable: true,
      enumerable: true
    })
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
    // They should not be synced to native storage
    if (typeof key === 'symbol') {
      return
    }

    // Sync to native storage
    this.#syncTagToNative(key, value)
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
   * Get the native span ID as BigInt.
   * @returns {bigint}
   */
  get nativeSpanId () {
    return this._nativeSpanId
  }
}

module.exports = NativeSpanContext
