'use strict'

const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const dateNow = Date.now
const { channel } = require('dc-polyfill')

const DatadogSpan = require('../opentracing/span')
const id = require('../id')
const tagger = require('../tagger')
const { MANUAL_DROP, MANUAL_KEEP, SAMPLING_PRIORITY } = require('../../../../ext/tags')
const { DD_MAJOR } = require('../../../../version')
const { MAX_META_VALUE_LENGTH } = require('../encode/tags-processors')
const { encode: encodeMsgpack } = require('../msgpack')
const NativeSpanContext = require('./span_context')
const { OpCode } = require('./index')

// Republished from the `addTags` override so subscribers (e.g. the wall
// profiler's web-tag refresh) still receive tag updates on the native path.
const tagsUpdateCh = channel('dd-trace:span:tags:update')

// Combine shared high trace-id bits with the low 64-bit identifier.
function buildNativeTraceId (lowId, tidHex) {
  if (!tidHex) return lowId
  // A 16-byte propagated id stores its low bits in the final eight bytes.
  const buf = lowId.toBuffer()
  const low = buf.length > 8 ? buf.slice(-8) : buf
  return [
    Number.parseInt(tidHex.slice(0, 2), 16),
    Number.parseInt(tidHex.slice(2, 4), 16),
    Number.parseInt(tidHex.slice(4, 6), 16),
    Number.parseInt(tidHex.slice(6, 8), 16),
    Number.parseInt(tidHex.slice(8, 10), 16),
    Number.parseInt(tidHex.slice(10, 12), 16),
    Number.parseInt(tidHex.slice(12, 14), 16),
    Number.parseInt(tidHex.slice(14, 16), 16),
    low[0], low[1], low[2], low[3], low[4], low[5], low[6], low[7],
  ]
}

// Empty span-event attribute buffer (shared; the decoder treats an empty
// buffer as "no attributes").
const EMPTY_ATTRS = Buffer.alloc(0)

// Match the legacy v0.4 meta_struct filter before generic msgpack encoding.
function cleanMetaStructValue (value, seen = new Set()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return
    seen.add(value)
    const out = []
    for (const item of value) {
      if (typeof item === 'string' || typeof item === 'number') {
        out.push(item)
      } else if (item !== null && typeof item === 'object' && !seen.has(item)) {
        out.push(cleanMetaStructValue(item, seen))
      }
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return
    seen.add(value)
    const out = {}
    for (const key of Object.keys(value)) {
      const v = value[key]
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[key] = v
      } else if (v !== null && typeof v === 'object' && !seen.has(v)) {
        out[key] = cleanMetaStructValue(v, seen)
      }
    }
    return out
  }
  return value
}

// `[len:u32 LE][utf8]`.
function encodeLenPrefixedStr (s) {
  const body = Buffer.from(s, 'utf8')
  const out = Buffer.allocUnsafe(4 + body.length)
  out.writeUInt32LE(body.length >>> 0, 0)
  body.copy(out, 4)
  return out
}

// Span-event scalar tags: String=0, Boolean=1, Integer=2, Double=3.
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
  // Only safe integers can round-trip through the i64 representation.
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

// Encode repeated `[key_len][key][tag][value]` entries for the native event
// decoder. Arrays use tag 4 and contain scalar entries only.
function appendSpanEventAttr (chunks, key, value) {
  if (Array.isArray(value)) {
    const header = Buffer.allocUnsafe(5)
    header.writeUInt8(4, 0)
    header.writeUInt32LE(value.length >>> 0, 1)
    chunks.push(encodeLenPrefixedStr(key), header)
    for (const item of value) {
      chunks.push(encodeAttrScalar(item))
    }
    return
  }
  chunks.push(encodeLenPrefixedStr(key), encodeAttrScalar(value))
}

// Encode sanitized span-event attributes (`_sanitizeEventAttributes` leaves
// scalars or arrays of scalars) for `addSpanEvent`.
function encodeSpanEventAttrs (attributes) {
  if (!attributes) return EMPTY_ATTRS
  const keys = Object.keys(attributes)
  if (keys.length === 0) return EMPTY_ATTRS
  const chunks = []
  for (const key of keys) {
    appendSpanEventAttr(chunks, key, attributes[key])
  }
  if (chunks.length === 0) return EMPTY_ATTRS
  return Buffer.concat(chunks)
}

// `super()` invokes `_createContext` before this instance exists. The temporary
// module-local handoff is safe because construction is synchronous.
let pendingNativeSpans = null

/**
 * DatadogSpan backed by native storage.
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

    // Parent wrote initial tags via `Object.assign(getTags(), tags)`,
    // which bypasses NativeSpanContext.setTag's native-sync path. Push
    // them to WASM now (no JS-cache write — the parent already did it).
    if (fields.tags) {
      this._spanContext.syncToNativeOnly(fields.tags)
    }

    processor?._exporter?._trackSpanStart?.()
  }

  /**
   * Allocate a native slot, build a NativeSpanContext, queue the
   * combined CreateSpan op (Create + SetName + SetStart in one WASM
   * call). The inherited constructor stores the initial name locally after
   * this returns; final synchronization owns subsequent name changes.
   *
   * @param {object|null} parent
   * @param {object} fields
   * @returns {NativeSpanContext}
   */
  _createContext (parent, fields) {
    const nativeSpans = pendingNativeSpans

    // Match the JS formatter's string coercion at creation.
    const operationName = String(fields.operationName)
    const tracer = this.tracer()
    const propagationBehavior = tracer?._config?.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
    const tracerService = tracer?._service
    const tracerServiceLower = tracer?.serviceLower

    let spanContext
    let startTime
    let parentId

    let baggage = {}
    if (parent && parent._isRemote && propagationBehavior !== 'continue') {
      baggage = parent._baggageItems
      parent = null
    }

    if (fields.context) {
      // Re-wrapping would leak or duplicate native span storage.
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
        tracerServiceLower,
      })

      if (!spanContext._trace.startTime) startTime = dateNow()
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
        tracerServiceLower,
      })

      if (!spanContext._trace.startTime) startTime = dateNow()
      parentId = parent._spanId
    } else {
      // Root span - generate new trace ID and span ID.
      const spanId = id()
      startTime = dateNow()

      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: spanId,
        spanId,
        tracerService,
        tracerServiceLower,
      })
      spanContext._trace.startTime = startTime

      if (fields.traceId128BitGenerationEnabled) {
        const tidHex = Math.floor(startTime / 1000).toString(16)
          .padStart(8, '0')
          .padEnd(16, '0')
        spanContext._trace.tags['_dd.p.tid'] = tidHex
      }
      parentId = null

      if (propagationBehavior === 'restart') {
        spanContext._baggageItems = baggage
      }
    }

    spanContext._trace.ticks ||= now()
    if (startTime) spanContext._trace.startTime = startTime
    spanContext._isRemote = false

    // Pin one start time for both native state and the parent constructor.
    const createStartTime = fields.startTime === undefined
      ? spanContext._trace.startTime + now() - spanContext._trace.ticks
      : fields.startTime
    fields.startTime = createStartTime

    // CreateSpanFull carries the common immutable/default core fields natively
    // (name, service, resource, type, start), so final sync can skip no-op
    // overwrites unless user tags changed them.
    // One segment id per local trace, shared by all its spans via the
    // shared `_trace` object (the local root allocates; children reuse).
    // Required by the native chunk flush, which keys a chunk by segment.
    const segmentId = (spanContext._trace._nativeSegmentId ??= nativeSpans.allocSegment())
    const nativeService = typeof fields.tags?.['service.name'] === 'string'
      ? fields.tags['service.name']
      : String(tracerService || '')
    const nativeResource = typeof fields.tags?.['resource.name'] === 'string'
      ? fields.tags['resource.name']
      : operationName
    const nativeType = typeof fields.tags?.['span.type'] === 'string'
      ? fields.tags['span.type']
      : ''
    // A trace ID is immutable and the trace object is shared by every local
    // span. Reuse the full 128-bit byte representation instead of rebuilding
    // its high half and allocating a 16-entry array for every child.
    const traceId = (spanContext._trace._nativeTraceId ??= buildNativeTraceId(
      spanContext._traceId,
      spanContext._trace.tags['_dd.p.tid']
    ))

    nativeSpans.queueCreateSpanFull(
      spanContext._nativeSpanId,
      traceId,
      segmentId,
      parentId,
      operationName,
      nativeService,
      nativeResource,
      nativeType,
      createStartTime
    )
    spanContext._recordNativeCoreFields?.(operationName, nativeResource, nativeService, nativeType)

    return spanContext
  }

  /**
   * Set one tag without allocating the batched `addTags` intermediates.
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

    if (isSamplingPriorityTag(key) && this._spanContext._sampling.priority === undefined) {
      this._prioritySampler.sample(this, false)
    }
    if (tagsUpdateCh.hasSubscribers) {
      tagsUpdateCh.publish(this)
    }
    return this
  }

  /**
   * Add tags while preserving the base span's accepted input shapes.
   *
   * @param {Record<string, unknown> | string | string[]} keyValuePairs
   * @returns {this}
   */
  addTags (keyValuePairs) {
    let mayChangeSamplingPriority

    // Plain-object hot path; Object.assign preserves internal symbol keys.
    if (keyValuePairs !== null && typeof keyValuePairs === 'object' && !Array.isArray(keyValuePairs)) {
      const tags = this._spanContext.getTags()
      Object.assign(tags, keyValuePairs)
      this._spanContext.syncToNativeOnly(keyValuePairs)
      mayChangeSamplingPriority =
        MANUAL_KEEP in keyValuePairs ||
        MANUAL_DROP in keyValuePairs ||
        SAMPLING_PRIORITY in keyValuePairs
    } else {
      // String/array forms remain a v5-only fallback.
      /* istanbul ignore if: v5 fallback, master ships 6.0.0-pre */
      if (DD_MAJOR < 6 && (typeof keyValuePairs === 'string' || Array.isArray(keyValuePairs))) {
        const tags = this._spanContext.getTags()
        const parsedTags = {}
        tagger.add(parsedTags, keyValuePairs)
        Object.assign(tags, parsedTags)
        this._spanContext.syncToNativeOnly(parsedTags)
        mayChangeSamplingPriority = true
      } else {
        return this
      }
    }

    if (mayChangeSamplingPriority && this._spanContext._sampling.priority === undefined) {
      this._prioritySampler.sample(this, false)
    }
    if (tagsUpdateCh.hasSubscribers) tagsUpdateCh.publish(this)
    return this
  }

  /**
   * Finalize native-only fields before the parent processor exports the span.
   * Reuse the resolved finish time in both implementations.
   *
   * @param {number} [finishTime]
   * @returns {void}
   */
  finish (finishTime) {
    if (this._duration !== undefined) return

    const exported = typeof this._spanContext.isExported === 'function' && this._spanContext.isExported()

    if (!exported) {
      this.#serializeSpanLinks()
      this.#serializeSpanEvents()
      this.#serializeMetaStruct()
    }

    // Mirror the parent's normalization (opentracing/span.js line 292).
    const resolvedFinishTime = finishTime === undefined
      ? this._getTime()
      : (Number.parseFloat(finishTime) || this._getTime())

    if (!exported) {
      this._nativeSpans.queueOp(
        OpCode.SetDuration,
        this._spanContext._nativeSpanId,
        ['ns', resolvedFinishTime - this._startTime]
      )
    }

    try {
      super.finish(resolvedFinishTime)
    } finally {
      this._processor?._exporter?._trackSpanFinish?.()
    }
  }

  _tryFastNativeFinalSync () {
    if (this._links?.length || this._events?.length) return false
    const metaStruct = this.meta_struct
    if (metaStruct && typeof metaStruct === 'object' && Object.keys(metaStruct).length > 0) return false
    return this._spanContext.tryFastFinalTagsToNative?.() === true
  }

  /**
   * Serialize bounded span-link metadata.
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
   * Send typed native events when supported; otherwise use the legacy JSON
   * meta fallback. OTLP always uses native events.
   */
  #serializeSpanEvents () {
    if (!this._events?.length) return

    const config = this.tracer()._config
    if (config.DD_TRACE_NATIVE_SPAN_EVENTS || config.OTEL_TRACES_EXPORTER === 'otlp') {
      for (const event of this._events) {
        // Drop malformed names rather than throwing from application finish().
        if (event === null || typeof event !== 'object' || typeof event.name !== 'string') continue
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
    this._spanContext.setTag('events', serialized)
  }

  /**
   * Msgpack-encode supported meta_struct entries for native storage.
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
          // Strip nulls to match the legacy v0.4 encoder (see cleanMetaStructValue).
          encodeMsgpack(cleanMetaStructValue(value))
        )
      }
    }
  }
}

module.exports = NativeDatadogSpan

function isSamplingPriorityTag (key) {
  return key === MANUAL_KEEP || key === MANUAL_DROP || key === SAMPLING_PRIORITY
}
