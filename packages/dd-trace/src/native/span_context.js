'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const { BASE_SERVICE, MEASURED } = require('../../../../ext/tags')
const { OpCode } = require('./index')

/**
 * NativeSpanContext extends DatadogSpanContext to store span data in native Rust storage.
 *
 * `setTag()` syncs tag writes immediately to native storage. External callers
 * should prefer `setTag()`/`getTag()`. Internal hot paths (`#addTags` and
 * `#addOneTag` in native/span.js) deliberately mutate `_tags` directly to
 * take a batched-sync fast path; those sites are responsible for calling
 * `syncToNativeOnly()` / `syncOneTagToNative()` afterwards to keep WASM
 * storage in lock-step.
 *
 * Key differences from DatadogSpanContext:
 * - Has a `_nativeSpanId` (byte buffer) for native operations
 * - `setTag()` syncs to native storage immediately
 */
// Tags that have dedicated OpCodes or special handling in syncTagToNative.
// Everything else is a plain meta string or metric number.
const SPECIAL_KEYS = new Set([
  'service.name', 'service', 'resource.name', 'span.type',
  'error', 'http.status_code', 'error.type', 'span.kind',
])

// Symbol keys for internal backing storage — avoids Object.defineProperty deopt
// while keeping properties non-enumerable to external code.
const NAME_VALUE = Symbol('nameValue')
const NATIVE_READY = Symbol('nativeReady')

class NativeSpanContext extends DatadogSpanContext {
  #nativeSpans

  /**
   * @param {import('./native_spans')} nativeSpans - The NativeSpansInterface instance
   * @param {object} props - SpanContext properties
   * @param {import('../id')} props.traceId - Trace ID
   * @param {import('../id')} props.spanId - Span ID
   * @param {import('../id')|null} [props.parentId] - Parent span ID
   * @param {object} [props.sampling] - Sampling information
   * @param {object} [props.baggageItems] - Baggage items
   * @param {object} [props.trace] - Shared trace object
   * @param {object} [props.tracestate] - W3C tracestate
   * @param {string} [props.tracerService] - Tracer's configured service name (for BASE_SERVICE)
   */
  constructor (nativeSpans, props) {
    // The `_name` setter (defined below) fires during `super(props)` when the
    // parent constructor assigns `this._name`. At that point `this[NATIVE_READY]`
    // is `undefined` (falsy), so the setter takes the local-only branch and
    // skips `_syncNameToNative`. We flip NATIVE_READY to `true` only after
    // super() completes — see line below.
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
    this._slotIndex = props.slotIndex
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
   * @param {string | symbol} key - Tag key
   * @param {unknown} value - Tag value
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
        this._slotIndex,
        key,
        value,
      )
      return
    }

    // Fast path: non-special number tags
    if (typeof value === 'number' && !SPECIAL_KEYS.has(key)) {
      this.#nativeSpans.queueOp(
        OpCode.SetMetricAttr,
        this._slotIndex,
        key,
        ['f64', value],
      )
      return
    }

    // Sync to native storage (special tags + booleans)
    this.#syncTagToNative(key, value)
  }

  /**
   * Sync tags to native storage only (JS cache already populated).
   * Separates special tags from plain meta/metric tags and batches the latter.
   *
   * @param {object} tags - Tag object to sync
   */
  syncToNativeOnly (tags) {
    const metaBatch = []
    const metricBatch = []

    // `Object.keys` skips Symbol-keyed entries (which never have a native
    // counterpart) and stays inside the project's no-`for-in` rule.
    for (const key of Object.keys(tags)) {
      const value = tags[key]
      if (value === undefined || value === null) continue

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
      this.#nativeSpans.queueBatchMeta(this._slotIndex, metaBatch)
    }
    if (metricBatch.length > 0) {
      this.#nativeSpans.queueBatchMetrics(this._slotIndex, metricBatch)
    }
  }

  /**
   * Single-tag fast path used by Span#setTag. Avoids the array allocations
   * (`metaBatch`, `metricBatch`, plus the `[[k,v]]` pair) that syncToNativeOnly
   * does for the batched case.
   *
   * @param {string} key
   * @param {unknown} value
   */
  syncOneTagToNative (key, value) {
    if (value === undefined || value === null) return
    if (typeof key === 'symbol') return

    if (SPECIAL_KEYS.has(key)) {
      this.#syncTagToNative(key, value)
    } else if (typeof value === 'number') {
      this.#nativeSpans.queueBatchMetrics(this._slotIndex, [[key, value]])
    } else if (typeof value === 'boolean') {
      this.#nativeSpans.queueBatchMetrics(this._slotIndex, [[key, value ? 1 : 0]])
    } else {
      this.#nativeSpans.queueBatchMeta(this._slotIndex, [[key, String(value)]])
    }
  }

  /**
   * Sync a tag value to native storage.
   * @param {string} key - Tag key
   * @param {unknown} value - Tag value
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
          this._slotIndex,
          String(value)
        )
        // Set _dd.base_service when the span's service differs from the
        // tracer's configured service so downstream consumers can identify the
        // owning service.
        if (this._tracerService && String(value).toLowerCase() !== this._tracerService.toLowerCase()) {
          super.setTag(BASE_SERVICE, this._tracerService)
          this.#nativeSpans.queueOp(
            OpCode.SetMetaAttr,
            this._slotIndex,
            BASE_SERVICE,
            String(this._tracerService)
          )
        }
        return

      case 'service':
        // Treat the bare `service` key as an alias for `service.name`. We
        // already routed `service.name` through SetServiceName above; if a
        // caller writes the alias, fall through to the same opcode rather
        // than queueing a meta tag.
        this.#nativeSpans.queueOp(
          OpCode.SetServiceName,
          this._slotIndex,
          String(value)
        )
        return

      case 'resource.name':
        this.#nativeSpans.queueOp(
          OpCode.SetResourceName,
          this._slotIndex,
          String(value)
        )
        return

      case 'span.type':
        this.#nativeSpans.queueOp(
          OpCode.SetType,
          this._slotIndex,
          String(value)
        )
        return

      case 'error':
        // fs.operation spans suppress span.error = 1; the error details are
        // still carried in meta tags but the span itself isn't marked failed,
        // since fs ops failing isn't always a tracer-level error.
        if (this._name === 'fs.operation') {
          return
        }
        this.#nativeSpans.queueOp(
          OpCode.SetError,
          this._slotIndex,
          ['i32', value ? 1 : 0]
        )
        // Error objects: also extract error.type/message/stack as meta tags so
        // consumers don't need to introspect the underlying Error.
        if (value instanceof Error) {
          if (value.name) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._slotIndex, 'error.type', String(value.name))
          }
          if (value.message || value.code) {
            const errMsg = String(value.message || value.code)
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._slotIndex, 'error.message', errMsg)
          }
          if (value.stack) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._slotIndex, 'error.stack', String(value.stack))
          }
        }
        return

      // http.status_code must be stored as string in meta, not number in
      // metrics — agent UI / downstream tooling expects the string form.
      case 'http.status_code':
        this.#nativeSpans.queueOp(
          OpCode.SetMetaAttr,
          this._slotIndex,
          key,
          String(value)
        )
        return

      // Setting error.type implies span.error = 1, except on fs.operation
      // spans which deliberately don't propagate fs failures up.
      case 'error.type':
        if (this._name !== 'fs.operation') {
          this.#nativeSpans.queueOp(
            OpCode.SetError,
            this._slotIndex,
            ['i32', 1]
          )
        }
        // Fall through to add the meta tag
        this.#nativeSpans.queueOp(
          OpCode.SetMetaAttr,
          this._slotIndex,
          key,
          String(value)
        )
        return

      // Setting span.kind automatically marks the span as measured
      // so the agent computes metrics, unless the kind is 'internal'.
      case 'span.kind':
        if (String(value) !== 'internal') {
          this.#nativeSpans.queueOp(
            OpCode.SetMetricAttr,
            this._slotIndex,
            MEASURED,
            ['f64', 1]
          )
        }
        // Fall through to add the meta tag
        this.#nativeSpans.queueOp(
          OpCode.SetMetaAttr,
          this._slotIndex,
          key,
          String(value)
        )
        return

      default:
        // Regular tags go to meta (string) or metrics (number)
        if (typeof value === 'number') {
          this.#nativeSpans.queueOp(
            OpCode.SetMetricAttr,
            this._slotIndex,
            key,
            ['f64', value]
          )
        } else if (typeof value === 'boolean') {
          // Booleans are stored as metrics (0 or 1)
          this.#nativeSpans.queueOp(
            OpCode.SetMetricAttr,
            this._slotIndex,
            key,
            ['f64', value ? 1 : 0]
          )
        } else {
          this.#nativeSpans.queueOp(
            OpCode.SetMetaAttr,
            this._slotIndex,
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
      this._slotIndex,
      String(name)
    )
  }
}

module.exports = NativeSpanContext
