'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const { OpCode } = require('./index')

/**
 * NativeSpanContext extends DatadogSpanContext to store span data in native Rust storage.
 *
 * This class maintains the same interface as DatadogSpanContext but uses a Proxy
 * to sync tag writes immediately to native storage. The Proxy is necessary because
 * tags have arbitrary dynamic keys that cannot be handled with static getters/setters.
 *
 * Key differences from DatadogSpanContext:
 * - Has a _nativeSpanId (BigInt) for native operations
 * - Tag writes are immediately synced to native storage via Proxy
 */
class NativeSpanContext extends DatadogSpanContext {
  #tagsCache
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
   */
  constructor (nativeSpans, props) {
    super(props)

    this.#nativeSpans = nativeSpans
    this._nativeSpanId = props.spanId.toBigInt()

    // Cache for tags - reads come from here, writes sync to native
    this.#tagsCache = props.tags || {}

    // Replace inherited _tags with a Proxy that syncs writes to native
    this._tags = this.#createTagsProxy()
  }

  /**
   * Create a Proxy for tags that syncs writes immediately to native storage.
   * A Proxy is required because tags have arbitrary dynamic keys that cannot
   * be handled with static getters/setters.
   * @returns {Proxy}
   */
  #createTagsProxy () {
    const self = this
    return new Proxy(this.#tagsCache, {
      get (target, key) {
        return target[key]
      },

      set (target, key, value) {
        if (typeof key === 'symbol') {
          target[key] = value
          return true
        }

        target[key] = value
        self.#syncTagToNative(key, value)
        return true
      },

      deleteProperty (target, key) {
        delete target[key]
        return true
      },

      has (target, key) {
        return key in target
      },

      ownKeys (target) {
        return Object.keys(target)
      },

      getOwnPropertyDescriptor (target, key) {
        if (key in target) {
          return {
            value: target[key],
            writable: true,
            enumerable: true,
            configurable: true
          }
        }
        return undefined
      }
    })
  }

  /**
   * Sync a tag value to native storage immediately.
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
        this.#nativeSpans.queueOp(
          OpCode.SetError,
          this._nativeSpanId,
          ['i32', value ? 1 : 0]
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
