'use strict'

const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const dateNow = Date.now

const DatadogSpan = require('../opentracing/span')
const id = require('../id')
const tagger = require('../tagger')
const { MAX_META_VALUE_LENGTH } = require('../encode/tags-processors')
const { MsgpackEncoder } = require('../msgpack')
const NativeSpanContext = require('./span_context')
const { OpCode } = require('./index')

// Reused across spans to encode meta_struct values to msgpack bytes, matching
// the legacy encoder's `meta_struct` map<string, bin> wire shape.
const metaStructEncoder = new MsgpackEncoder()

// Empty span-event attribute buffer (shared; the decoder treats an empty
// buffer as "no attributes").
const EMPTY_ATTRS = Buffer.alloc(0)

// `[len:u32 LE][utf8]`.
function encodeLenPrefixedStr (s) {
  const body = Buffer.from(s, 'utf8')
  const out = Buffer.allocUnsafe(4 + body.length)
  out.writeUInt32LE(body.length >>> 0, 0)
  body.copy(out, 4)
  return out
}

// `[tag:u8] + value` for a scalar span-event attribute. Tags match
// libdatadog's AttributeArrayValue discriminants: String=0, Boolean=1,
// Integer=2, Double=3.
function encodeAttrScalar (value) {
  if (typeof value === 'string') {
    const body = encodeLenPrefixedStr(value)
    const out = Buffer.allocUnsafe(1 + body.length)
    out.writeUInt8(0, 0)
    body.copy(out, 1)
    return out
  }
  if (typeof value === 'boolean') {
    return Buffer.from([1, value ? 1 : 0])
  }
  // number: a *safe* integer -> i64 (tag 2), otherwise f64 (tag 3). Only
  // `Number.isSafeInteger` values are guaranteed to be exact and within i64
  // range; a larger integer-valued float (e.g. 1e21) would overflow
  // `writeBigInt64LE` (RangeError) and isn't exactly representable anyway, so
  // it goes to double — which is also what its JS value already is.
  const out = Buffer.allocUnsafe(9)
  if (Number.isSafeInteger(value)) {
    out.writeUInt8(2, 0)
    out.writeBigInt64LE(BigInt(value), 1)
  } else {
    out.writeUInt8(3, 0)
    out.writeDoubleLE(value, 1)
  }
  return out
}

// Encode sanitized span-event attributes (`_sanitizeEventAttributes` leaves
// scalars or arrays of scalars) into the flat little-endian buffer the native
// `addSpanEvent` decodes (`decode_span_event_attributes` in the pipeline
// crate): repeated `[key_len:u32][key][tag:u8] + value`, where an array value
// is `[4][count:u32]` followed by `count` `[item_tag:u8] + scalar` items.
function encodeSpanEventAttrs (attributes) {
  if (!attributes) return EMPTY_ATTRS
  const keys = Object.keys(attributes)
  if (keys.length === 0) return EMPTY_ATTRS
  const chunks = []
  for (const key of keys) {
    chunks.push(encodeLenPrefixedStr(key))
    const value = attributes[key]
    if (Array.isArray(value)) {
      const head = Buffer.allocUnsafe(5)
      head.writeUInt8(4, 0)
      head.writeUInt32LE(value.length >>> 0, 1)
      chunks.push(head)
      for (const item of value) chunks.push(encodeAttrScalar(item))
    } else {
      chunks.push(encodeAttrScalar(value))
    }
  }
  return Buffer.concat(chunks)
}

// `_createContext` is invoked by the parent constructor via `super(...)`
// BEFORE the subclass can touch `this`, so we cannot thread
// `nativeSpans` through the instance. Stash it module-locally; JS's
// single-threaded execution model makes the read-back in
// `_createContext` race-free. The try/finally in the constructor
// clears this even if super throws (e.g. the wrap-existing-context
// guard below).
let pendingNativeSpans = null

// Shadows `NativeSpanContext.prototype._syncNameToNative` on the
// instance during construction so the parent's
// `this._spanContext._name = operationName` line (opentracing/span.js)
// does not emit a redundant SetName WASM op alongside the combined
// CreateSpan op we queue ourselves. The subclass constructor deletes
// the shadow once super() returns.
const noopSyncName = () => {}

/**
 * NativeDatadogSpan stores span data in native Rust storage via
 * NativeSpansInterface, replacing the JS-side trace buffer. It inherits
 * the bulk of DatadogSpan's lifecycle, link/event, and tag handling;
 * only methods with native-sync side effects are overridden here.
 */
class NativeDatadogSpan extends DatadogSpan {
  /**
   * @param {object} tracer
   * @param {object} processor
   * @param {object} prioritySampler
   * @param {object} fields
   * @param {string} fields.operationName
   * @param {object|null} [fields.parent]
   * @param {object} [fields.tags]
   * @param {number} [fields.startTime]
   * @param {string} [fields.hostname]
   * @param {boolean} [fields.traceId128BitGenerationEnabled]
   * @param {string} [fields.integrationName]
   * @param {Array} [fields.links]
   * @param {boolean} debug
   * @param {import('./native_spans')} nativeSpans
   */
  constructor (tracer, processor, prioritySampler, fields, debug, nativeSpans) {
    pendingNativeSpans = nativeSpans
    try {
      super(tracer, processor, prioritySampler, fields, debug)
    } finally {
      pendingNativeSpans = null
    }

    this._nativeSpans = nativeSpans

    // Restore the prototype `_syncNameToNative` (shadowed in
    // `_createContext`) so later `setOperationName` calls reach the
    // real WASM-syncing method.
    delete this._spanContext._syncNameToNative

    // Parent wrote initial tags via `Object.assign(getTags(), tags)`,
    // which bypasses NativeSpanContext.setTag's native-sync path. Push
    // them to WASM now (no JS-cache write — the parent already did it).
    if (fields.tags) {
      this._spanContext.syncToNativeOnly(fields.tags)
    }
  }

  /**
   * Allocate a native slot, build a NativeSpanContext, queue the
   * combined CreateSpan op (Create + SetName + SetStart in one WASM
   * call), and silently set the initial name. The subclass constructor
   * (after super) restores the prototype `_syncNameToNative` so future
   * name changes reach WASM normally.
   *
   * @param {object|null} parent
   * @param {object} fields
   * @returns {NativeSpanContext}
   */
  _createContext (parent, fields) {
    const nativeSpans = pendingNativeSpans

    const operationName = fields.operationName
    const tracer = this.tracer()
    const propagationBehavior = tracer?._config?.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
    const tracerService = tracer?._service

    let spanContext
    let startTime
    let traceId
    let parentId

    let baggage = {}
    if (parent && parent._isRemote && propagationBehavior !== 'continue') {
      baggage = parent._baggageItems
      parent = null
    }

    if (fields.context) {
      // Re-wrapping a NativeSpanContext would either leak the freshly
      // allocated slot (early return) or duplicate the span across two
      // slots. Free the slot and throw loudly.
      const existingContext = fields.context
      if (existingContext._nativeSpanId !== undefined) {
        throw new Error('NativeDatadogSpan cannot wrap an existing NativeSpanContext')
      }

      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: existingContext._traceId,
        spanId: existingContext._spanId,
        parentId: existingContext._parentId,
        sampling: existingContext._sampling,
        baggageItems: { ...existingContext._baggageItems },
        tags: { ...existingContext.getTags() },
        trace: existingContext._trace,
        tracestate: existingContext._tracestate,
        tracerService,
      })

      if (!spanContext._trace.startTime) startTime = dateNow()
      traceId = existingContext._traceId
      parentId = existingContext._parentId
    } else if (parent) {
      const spanId = id()
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: parent._traceId,
        spanId,
        parentId: parent._spanId,
        sampling: parent._sampling,
        baggageItems: { ...parent._baggageItems },
        trace: parent._trace,
        tracestate: parent._tracestate,
        tracerService,
      })

      if (!spanContext._trace.startTime) startTime = dateNow()
      traceId = parent._traceId
      parentId = parent._spanId
    } else {
      // Root span - generate new trace ID and span ID.
      const spanId = id()
      startTime = dateNow()

      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: spanId,
        spanId,
        tracerService,
      })
      spanContext._trace.startTime = startTime

      if (fields.traceId128BitGenerationEnabled) {
        const tidHex = Math.floor(startTime / 1000).toString(16)
          .padStart(8, '0')
          .padEnd(16, '0')
        spanContext._trace.tags['_dd.p.tid'] = tidHex
        // Build 16-byte trace ID: [high 8 bytes from timestamp][low 8 bytes from spanId]
        const spanIdBuf = spanId.toBuffer()
        traceId = [
          Number.parseInt(tidHex.slice(0, 2), 16),
          Number.parseInt(tidHex.slice(2, 4), 16),
          Number.parseInt(tidHex.slice(4, 6), 16),
          Number.parseInt(tidHex.slice(6, 8), 16),
          Number.parseInt(tidHex.slice(8, 10), 16),
          Number.parseInt(tidHex.slice(10, 12), 16),
          Number.parseInt(tidHex.slice(12, 14), 16),
          Number.parseInt(tidHex.slice(14, 16), 16),
          spanIdBuf[0], spanIdBuf[1], spanIdBuf[2], spanIdBuf[3],
          spanIdBuf[4], spanIdBuf[5], spanIdBuf[6], spanIdBuf[7],
        ]
      } else {
        traceId = spanId
      }
      parentId = null

      if (propagationBehavior === 'restart') {
        spanContext._baggageItems = baggage
      }
    }

    spanContext._trace.ticks = spanContext._trace.ticks || now()
    if (startTime) spanContext._trace.startTime = startTime
    spanContext._isRemote = false

    // Same formula as the parent's later
    // `this._startTime = fields.startTime || this._getTime()`.
    // Sub-microsecond `performance.now()` drift between the two
    // computations is below export resolution.
    const createStartTime = fields.startTime === undefined
      ? spanContext._trace.startTime + now() - spanContext._trace.ticks
      : fields.startTime

    // CreateSpan carries the name natively, so we set it silently on
    // the JS side and shadow `_syncNameToNative` with a no-op for the
    // duration of super(). See the constructor for the delete-restore.
    spanContext._setNameLocal(operationName)
    spanContext._syncNameToNative = noopSyncName

    // One segment id per local trace, shared by all its spans via the
    // shared `_trace` object (the local root allocates; children reuse).
    // Required by the native chunk flush, which keys a chunk by segment.
    const segmentId = (spanContext._trace._nativeSegmentId ??= nativeSpans.allocSegment())

    nativeSpans.queueCreateSpan(
      spanContext._nativeSpanId,
      traceId,
      segmentId,
      parentId,
      operationName,
      createStartTime
    )

    return spanContext
  }

  /**
   * Override `setTag` for a single-tag fast path that avoids the
   * `{ [key]: value }` literal + parsedTags round-trip the parent
   * does via `_addTags`, and short-circuits prioritySampler.sample
   * once a priority is decided (sample() early-returns but still
   * pays `_getContext()` + arg setup).
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {this}
   */
  setTag (key, value) {
    if (key === '' || key === undefined || typeof key === 'symbol') return this

    const tags = this._spanContext.getTags()
    tags[key] = value

    this._spanContext.syncOneTagToNative(key, value)

    if (this._spanContext._sampling.priority === undefined) {
      this._prioritySampler.sample(this, false)
    }
    return this
  }

  /**
   * Override `_addTags` (called by the inherited `addTags`) to route
   * batched tag writes through the native span context. Accepts a
   * plain `{k: v}` object (fast path), a `'k1:v1,k2:v2'` string, or
   * an array of such strings.
   *
   * @param {Record<string, unknown> | string | string[]} keyValuePairs
   * @returns {void}
   */
  _addTags (keyValuePairs) {
    const tags = this._spanContext.getTags()

    // Fast path: plain object (the hot path from instrumentations).
    // `tagger.add` for object input is just `Object.assign(parsedTags, kv)`,
    // so we skip the parsedTags allocation and copy kv straight in.
    // Use `Object.assign` (not `for-in`) so Symbol-keyed entries like
    // `IGNORE_OTEL_ERROR` reach the JS cache; `syncToNativeOnly` filters
    // symbol keys back out before they hit WASM.
    if (keyValuePairs && typeof keyValuePairs === 'object' && !Array.isArray(keyValuePairs)) {
      Object.assign(tags, keyValuePairs)
      this._spanContext.syncToNativeOnly(keyValuePairs)
      if (this._spanContext._sampling.priority === undefined) {
        this._prioritySampler.sample(this, false)
      }
      return
    }

    // Slow path: string or array input.
    const parsedTags = {}
    tagger.add(parsedTags, keyValuePairs)
    Object.assign(tags, parsedTags)
    this._spanContext.syncToNativeOnly(parsedTags)

    if (this._spanContext._sampling.priority === undefined) {
      this._prioritySampler.sample(this, false)
    }
  }

  /**
   * Override `finish` to serialize span links/events into meta tags
   * (so the native exporter ships them) and queue SetDuration BEFORE
   * delegating the rest of the bookkeeping — counters, runtime
   * metrics, trace.finished push, finishCh.publish, processor.process
   * — to `super.finish`. SetDuration must be queued before
   * processor.process triggers the native exporter to read state.
   *
   * Passing the precomputed `finishTime` to super avoids
   * `performance.now()` drift between our duration computation and
   * the one inside super.finish.
   *
   * @param {number} [finishTime]
   * @returns {void}
   */
  finish (finishTime) {
    if (this._duration !== undefined) return

    this.#serializeSpanLinks()
    this.#serializeSpanEvents()
    this.#serializeMetaStruct()

    // Mirror the parent's normalization (opentracing/span.js line 292).
    const resolvedFinishTime = finishTime === undefined
      ? this._getTime()
      : (Number.parseFloat(finishTime) || this._getTime())

    this._nativeSpans.queueOp(
      OpCode.SetDuration,
      this._spanContext._nativeSpanId,
      ['ns', resolvedFinishTime - this._startTime]
    )

    super.finish(resolvedFinishTime)
  }

  /**
   * Serialize span links to the `_dd.span_links` meta tag with
   * MAX_META_VALUE_LENGTH truncation — oversized link payloads would be
   * silently rejected by the agent.
   */
  #serializeSpanLinks () {
    if (!this._links?.length) return

    const links = this._links.map(link => {
      const { context, attributes } = link
      const formattedLink = {
        trace_id: context.toTraceId(true),
        span_id: context.toSpanId(true),
      }
      if (attributes && Object.keys(attributes).length > 0) {
        formattedLink.attributes = attributes
      }
      if (context?._sampling?.priority >= 0) {
        formattedLink.flags = context._sampling.priority > 0 ? 1 : 0
      }
      if (context?._tracestate) {
        formattedLink.tracestate = context._tracestate.toString()
      }
      return formattedLink
    })

    let serialized = JSON.stringify(links)
    if (serialized.length > MAX_META_VALUE_LENGTH) {
      serialized = `${serialized.slice(0, MAX_META_VALUE_LENGTH)}...`
    }
    this._spanContext.setTag('_dd.span_links', serialized)
  }

  /**
   * Serialize span events to the `_dd.span_events` meta tag as JSON.
   * The native exporter ships meta tags directly to the agent; the JS
   * exporter uses a top-level `span_events` field — so this is a
   * parallel-not-identical encoding. The agent accepts either form.
   */
  #serializeSpanEvents () {
    if (!this._events?.length) return

    // When native span events are enabled (matching the legacy encoder's
    // `DD_TRACE_NATIVE_SPAN_EVENTS` gate), append each event to the top-level
    // v0.4 `span_events` field via the native setter — no truncation, typed
    // attributes. Otherwise fall back to the `_dd.span_events` meta tag.
    if (this.tracer()._config.DD_TRACE_NATIVE_SPAN_EVENTS) {
      for (const event of this._events) {
        this._nativeSpans.addSpanEvent(
          this._spanContext._nativeSpanId,
          event.name,
          BigInt(Math.round(event.startTime * 1e6)),
          encodeSpanEventAttrs(event.attributes)
        )
      }
      return
    }

    const events = this._events.map(event => {
      const formatted = {
        name: event.name,
        time_unix_nano: Math.round(event.startTime * 1e6),
      }
      if (event.attributes && Object.keys(event.attributes).length > 0) {
        formatted.attributes = event.attributes
      }
      return formatted
    })

    let serialized = JSON.stringify(events)
    if (serialized.length > MAX_META_VALUE_LENGTH) {
      serialized = `${serialized.slice(0, MAX_META_VALUE_LENGTH)}...`
    }
    this._spanContext.setTag('_dd.span_events', serialized)
  }

  /**
   * Forward `meta_struct` entries (set ad-hoc on the span by products such as
   * AppSec, Code Origin and Dynamic Instrumentation) to native storage. Each
   * value is msgpack-encoded to bytes, matching how the legacy encoder writes
   * the v0.4 `meta_struct` map<string, bin> field. The value filter mirrors the
   * legacy `#encodeMetaStruct` (strings, numbers and non-null objects only).
   */
  #serializeMetaStruct () {
    const metaStruct = this.meta_struct
    if (!metaStruct || typeof metaStruct !== 'object') return

    for (const key of Object.keys(metaStruct)) {
      const value = metaStruct[key]
      if (typeof value === 'string' || typeof value === 'number' ||
        (value !== null && typeof value === 'object')) {
        this._nativeSpans.setMetaStruct(
          this._spanContext._nativeSpanId,
          key,
          metaStructEncoder.encode(value)
        )
      }
    }
  }
}

module.exports = NativeDatadogSpan
