'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const { IGNORE_OTEL_ERROR } = require('../constants')
const {
  applyHttpOtelSemantics,
  DD_HTTP_META_KEYS,
  NETWORK_DESTINATION_PORT,
  OTEL_OUTPUT_META_KEYS,
  OTEL_OUTPUT_METRIC_KEYS,
} = require('../plugins/util/http-otel-semantics')
const { OpCode } = require('./index')

/**
 * NativeSpanContext extends DatadogSpanContext to store span data in native Rust storage.
 *
 * `setTag()` keeps the JS tag cache authoritative. Native mode syncs one final
 * formatted snapshot immediately before export, because the current WASM
 * change-buffer API can add/overwrite fields but cannot remove stale meta or
 * metric entries after delete/type changes.
 *
 * Key differences from DatadogSpanContext:
 * - Has a `_nativeSpanId` (byte buffer) for native operations
 * - `syncFinalTagsToNative()` materializes the final JS wire state into WASM
 */
const ERROR_META_KEYS = new Set(['error.type', 'error.message', 'error.stack'])

// Symbol keys for internal backing storage — avoids Object.defineProperty deopt
// while keeping properties non-enumerable to external code.
const NAME_VALUE = Symbol('nameValue')

class NativeSpanContext extends DatadogSpanContext {
  #nativeSpans

  // Once this span has been exported, its Create has been removed from the WASM
  // change-buffer span map. Any further op we queue for it would reference a
  // missing span, making `flush_change_buffer` throw `span not found` and drop
  // the *entire* pending batch (orphaning other spans' Creates -> their trace is
  // lost). Late tags are meaningless anyway: the JS-only pipeline also serializes
  // spans at export time, so a `setTag` after export never reaches the wire.
  // Skipping native sync once exported keeps both pipelines consistent and
  // prevents the batch-drop cascade (see the elasticsearch product-check ping).
  #exported = false
  #hasErrorTags = false

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
    // During super(props), the `_name` setter stores the value locally. Native
    // sync happens later from the final formatted span snapshot.
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
  }

  // Class-level getter/setter for _name — intercepts writes to sync to native.
  // Uses Symbol-keyed backing store instead of Object.defineProperty to preserve
  // V8 hidden class optimization (all instances share the same shape).
  get _name () {
    return this[NAME_VALUE]
  }

  set _name (value) {
    this[NAME_VALUE] = value
  }

  /**
   * Mark this span as exported. After export its native Create has been removed
   * from the change-buffer span map, so all subsequent tag/name syncs are
   * skipped (see `#exported`).
   */
  markExported () {
    this.#exported = true
  }

  isExported () {
    return this.#exported
  }

  /**
   * Set a tag value. Native storage is updated from one final formatted
   * snapshot before export; eager writes would leave stale meta/metrics behind
   * when tags are deleted, cleared, or change type.
   * @param {string | symbol} key - Tag key
   * @param {unknown} value - Tag value
   */
  setTag (key, value) {
    super.setTag(key, value)
    if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
  }

  /**
   * Native storage is synced at finish from the final formatted span. This
   * method remains for the Span#addTags hot path: callers mutate the JS cache
   * directly and invoke this hook, so we only record whether error tags need the
   * final error-meta pass.
   *
   * @param {object} tags - Tag object to observe
   */
  syncToNativeOnly (tags) {
    if (this.#exported) return
    for (const key of Object.keys(tags)) {
      if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
    }
  }

  /**
   * Single-tag hook used by Span#setTag. See syncToNativeOnly: final snapshot
   * sync owns native writes.
   *
   * @param {string} key
   * @param {unknown} value
   */
  syncOneTagToNative (key, value) {
    if (this.#exported) return
    if (key === 'error' || ERROR_META_KEYS.has(key)) this.#hasErrorTags = true
  }

  /**
   * Sync the final formatted span representation to native storage. `formatted`
   * comes from span_format.js, so deletion, clear, string↔number replacement,
   * object flattening, truncation, error extraction, and OTel OK-overrides-ERROR
   * precedence all match the JS encoder.
   *
   * @param {object} formatted
   */
  syncFinalTagsToNative (formatted) {
    if (this.#exported) return

    const spanId = this._nativeSpanId
    this.#nativeSpans.queueOp(OpCode.SetName, spanId, String(formatted.name))
    this.#nativeSpans.queueOp(OpCode.SetResourceName, spanId, String(formatted.resource))
    if (typeof formatted.service === 'string') {
      this.#nativeSpans.queueOp(OpCode.SetServiceName, spanId, formatted.service)
    }
    if (typeof formatted.type === 'string') {
      this.#nativeSpans.queueOp(OpCode.SetType, spanId, formatted.type)
    }
    this.#nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', formatted.error ? 1 : 0])

    const metaBatch = []
    for (const key of Object.keys(formatted.meta)) {
      if (this.#isOtelDeferredKey(key)) continue
      metaBatch.push(key, formatted.meta[key])
    }
    if (metaBatch.length > 0) {
      this.#nativeSpans.queueBatchMetaFlat(spanId, metaBatch)
    }

    const metricBatch = []
    for (const key of Object.keys(formatted.metrics)) {
      if (this.#isOtelDeferredKey(key)) continue
      const value = formatted.metrics[key]
      if (typeof value === 'number' && !Number.isNaN(value)) metricBatch.push(key, value)
    }
    if (metricBatch.length > 0) {
      this.#nativeSpans.queueBatchMetricsFlat(spanId, metricBatch)
    }
  }

  /**
   * Replay error.type/message/stack from the final JS tag map, matching
   * span_format.js serialization-time extraction and overwrite order.
   */
  syncErrorMetaToNative () {
    if (this.#exported || !this.#hasErrorTags || this._name === 'fs.operation') return

    const tags = this.getTags()
    for (const key of Object.keys(tags)) {
      const value = tags[key]
      switch (key) {
        case 'error':
          if (value?.message || value instanceof Error) {
            if (value.name) {
              this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.type', String(value.name))
            }
            if (value.message || value.code) {
              this.#nativeSpans.queueOp(
                OpCode.SetMetaAttr,
                this._nativeSpanId,
                'error.message',
                String(value.message || value.code)
              )
            }
            if (value.stack) {
              this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, 'error.stack', String(value.stack))
            }
          }
          break
        case 'error.type':
        case 'error.message':
        case 'error.stack':
          if (!this.getTag(IGNORE_OTEL_ERROR)) {
            this.#nativeSpans.queueOp(OpCode.SetError, this._nativeSpanId, ['i32', 1])
          }
          if (value != null) {
            this.#nativeSpans.queueOp(OpCode.SetMetaAttr, this._nativeSpanId, key, String(value))
          }
          break
      }
    }
  }

  /**
   * Under DD_TRACE_OTEL_SEMANTICS_ENABLED the Datadog HTTP tags are remapped to
   * OpenTelemetry names at finish (see `applyOtelHttpSemantics`). WASM has no
   * remove-meta op, so these keys are held out of the store during the span's
   * life (they stay in the JS tag cache for runtime consumers and for the remap
   * to read) rather than syncing DD names we could never drop.
   *
   * @param {string} key
   * @returns {boolean}
   */
  #isOtelDeferredKey (key) {
    return this.#nativeSpans.otelSemanticsEnabled &&
      (DD_HTTP_META_KEYS.has(key) || key === NETWORK_DESTINATION_PORT)
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
   * Apply the OpenTelemetry HTTP semantic-convention remap to this span's
   * native output at finish. Datadog HTTP tags are skipped by
   * syncFinalTagsToNative(), so build a formatted view from the JS tag cache,
   * run the shared `applyHttpOtelSemantics`, and sync the resulting OTel
   * meta/metrics (plus any error/resource change) into WASM. No-op for
   * non-HTTP spans. Only invoked when the tracer runs with
   * DD_TRACE_OTEL_SEMANTICS_ENABLED.
   *
   * Divergence from master: because the DD HTTP tags are held out of WASM
   * entirely (not just renamed at serialization), the native trace-stats
   * concentrator (which runs in WASM at flush) sees the OTel names rather than
   * the DD `http.status_code`/etc. Master kept the DD tags on the span so stats
   * were unaffected. This only matters for the OTEL-semantics + native-stats
   * intersection and is an accepted limitation of the opt-in flag.
   */
  applyOtelHttpSemantics () {
    const tags = this.getTags()
    if (tags['http.method'] === undefined && tags['http.url'] === undefined) return

    // Rebuild the {meta, metrics} view the way the native span categorizes tags
    // (strings -> meta, finite numbers -> metrics), forcing http.status_code to
    // a meta string (its native special case) so the remap reads it.
    const meta = {}
    const metrics = {}
    for (const key of Object.keys(tags)) {
      const value = tags[key]
      if (value === null || value === undefined) continue
      if (key === 'http.status_code') {
        meta[key] = String(value)
      } else if (typeof value === 'number') {
        if (!Number.isNaN(value)) metrics[key] = value
      } else if (typeof value === 'boolean') {
        metrics[key] = value ? 1 : 0
      } else {
        meta[key] = String(value)
      }
    }

    const resourceBefore = typeof tags['resource.name'] === 'string' ? tags['resource.name'] : undefined
    const errorBefore = tags.error ? 1 : 0
    const view = { meta, metrics, error: errorBefore, resource: resourceBefore }

    applyHttpOtelSemantics(view)

    const spanId = this._nativeSpanId
    for (const key of OTEL_OUTPUT_META_KEYS) {
      const value = view.meta[key]
      if (value !== undefined) {
        this.#nativeSpans.queueOp(OpCode.SetMetaAttr, spanId, key, String(value))
      }
    }
    for (const key of OTEL_OUTPUT_METRIC_KEYS) {
      const value = view.metrics[key]
      if (value !== undefined) {
        this.#nativeSpans.queueOp(OpCode.SetMetricAttr, spanId, key, ['f64', value])
      }
    }
    // The remap flips error on for error responses; it never clears it.
    if (view.error === 1 && errorBefore !== 1) {
      this.#nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', 1])
    }
    // Only the unknown-verb (_OTHER) path rewrites the resource.
    if (typeof view.resource === 'string' && view.resource !== resourceBefore) {
      this.#nativeSpans.queueOp(OpCode.SetResourceName, spanId, view.resource)
    }
  }
}

module.exports = NativeSpanContext
