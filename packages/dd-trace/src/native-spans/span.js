'use strict'

const util = require('node:util')

const { storage } = require('../../../datadog-core')
const DatadogSpan = require('../opentracing/span')
const { LANES, nowMillis, splitMillisToNanoLanes } = require('./clock')
const { getWriter } = require('./event-writer')
const { NativeId, ZERO_ID, randomId, traceIdFrom } = require('./id')
const NativeSpanContext = require('./span_context')

// Reserved keys, resolved to fixed string ids on both sides of the FFI boundary.
const OPERATION_NAME = 'operation.name'
const TRACE_ID_128 = '_dd.p.tid'
const DD_INTEGRATION = '_dd.integration'

const ALLOWED = new Set(['string', 'number', 'boolean'])

/**
 * A `Span` whose every mutating method is a buffer write rather than a data
 * structure mutation. Nothing is retained for read-back beyond the four ids in
 * `NativeSpanContext` and this span's own start-time lanes, which exist only
 * because the duration has to be a lane-wise subtraction at finish.
 *
 * The prototype chain is spliced onto `DatadogSpan` so `instanceof` checks above
 * the construction point still recognise this as a span. Every method the public
 * surface exposes is overridden here — nothing is meant to fall through, and a
 * fall-through would hit `DatadogSpan`'s private fields and throw.
 */
class NativeSpan {
  #parentTracer
  #startHi
  #startLo
  #finished = false

  /**
   * @param {import('../opentracing/tracer')} tracer
   * @param {import('../span_processor')} _processor Unused: chunk assembly and
   * export live in the native extension.
   * @param {import('../priority_sampler')} _prioritySampler Unused: sampling is
   * a stated non-goal of this PoC.
   * @param {{
   *   operationName: string,
   *   parent?: object | null,
   *   startTime?: number,
   *   integrationName?: string,
   *   tags?: Record<string, unknown>,
   *   links?: Array<{ context: object, attributes?: Record<string, unknown> }>,
   * }} fields
   */
  constructor (tracer, _processor, _prioritySampler, fields) {
    const writer = getWriter()
    const startMillis = fields.startTime ?? nowMillis()
    const parent = fields.parent

    this.#parentTracer = tracer
    this._store = storage('legacy').getHandle()
    // Plain properties, not `#private`: both cross the class boundary. `web.js`
    // assigns `_integrationName` when a framework claims the span, and reads
    // `_name` to recognise a pubsub span. `_name` matches the baseline in not
    // tracking later renames — it exists for span-count metrics.
    this._name = fields.operationName
    this._integrationName = fields.integrationName ?? 'opentracing'

    splitMillisToNanoLanes(startMillis)
    const startHi = LANES[0]
    const startLo = LANES[1]
    this.#startHi = startHi
    this.#startLo = startLo

    let context
    if (parent?._segmentId === undefined) {
      // A new local trace root, so a new segment and the 128-bit trace id the whole
      // segment maps onto. A parent extracted from propagation is a foreign
      // `SpanContext` holding `Identifier`s rather than lanes: it still roots a new
      // segment, but the trace id and parent id come from it.
      const spanId = randomId()
      const remote = parent?._spanId === undefined ? undefined : parent
      const traceId = remote === undefined
        ? traceIdFrom(spanId, startMillis)
        : traceIdFromRemote(remote)
      const parentId = remote === undefined ? ZERO_ID : identifierToNativeId(remote._spanId)

      context = new NativeSpanContext(traceId, spanId, spanId, parentId)
      this._spanContext = context
      writer.segmentStart(context)
      writer.spanStart(context, startHi, startLo)
      // The upper 64 bits also travel as a tag, the same way the baseline emits them
      // as a chunk tag, so the agent sees an unchanged wire shape.
      writer.setTagString(context, TRACE_ID_128, remote === undefined
        ? traceIdHighHex(startMillis)
        : traceId.toString(16).slice(0, 16))
    } else {
      // Same segment as the parent: the cheap case, one new id and one record.
      context = new NativeSpanContext(parent._traceId, parent._segmentId, randomId(), parent._spanId)
      this._spanContext = context
      writer.spanStart(context, startHi, startLo)
    }

    // Name, service, resource and type are ordinary tags with reserved key ids;
    // `SPAN_START` carries none of them.
    writer.setTagString(context, OPERATION_NAME, fields.operationName)

    const tags = fields.tags
    if (tags) {
      for (const key of Object.keys(tags)) {
        context.setTag(key, tags[key])
      }
    }

    const links = fields.links
    if (links) {
      for (const link of links) {
        this.addLink(link)
      }
    }
  }

  [util.inspect.custom] () {
    return {
      _spanContext: this._spanContext,
      parentTracer: `[${this.#parentTracer.constructor.name}]`,
    }
  }

  /**
   * @returns {string}
   */
  toString () {
    const context = this._spanContext
    return `NativeSpan${JSON.stringify({
      traceId: context.toTraceId(true),
      spanId: context.toSpanId(),
      parentId: context._parentId.toString(10),
    })}`
  }

  /**
   * @returns {NativeSpanContext}
   */
  context () {
    return this._spanContext
  }

  tracer () {
    return this.#parentTracer
  }

  /**
   * @param {string} name
   * @returns {this}
   */
  setOperationName (name) {
    getWriter().setTagString(this._spanContext, OPERATION_NAME, name)
    return this
  }

  /**
   * Baggage has the same "no JS-side state to read back from" problem as the tag
   * getters, and out-of-process baggage propagation is out of scope here, so the
   * whole group is a silent no-op.
   *
   * @returns {this}
   */
  setBaggageItem () {
    return this
  }

  /** @returns {undefined} Baggage is never stored, so there is never anything to read. */
  getBaggageItem () {}

  /** @returns {string} */
  getAllBaggageItems () {
    return '{}'
  }

  removeBaggageItem () {}

  removeAllBaggageItems () {}

  /**
   * @param {string} key
   * @param {unknown} value
   * @returns {this}
   */
  setTag (key, value) {
    this._spanContext.setTag(key, value)
    return this
  }

  /**
   * One `setTag`-equivalent write per key rather than its own event kind.
   *
   * @param {Record<string, unknown>} keyValueMap
   * @returns {this}
   */
  addTags (keyValueMap) {
    if (keyValueMap === null || typeof keyValueMap !== 'object' || Array.isArray(keyValueMap)) {
      return this
    }

    const context = this._spanContext
    for (const key of Object.keys(keyValueMap)) {
      context.setTag(key, keyValueMap[key])
    }

    return this
  }

  /** @returns {this} */
  log () {
    return this
  }

  logEvent () {}

  /**
   * @param {{ context: object, attributes?: Record<string, unknown> }} link
   */
  addLink (link) {
    const { context, attributes } = link
    const target = context._ddContext ?? context
    getWriter().addLink(this._spanContext, target._spanId ?? ZERO_ID, serializeLink(target, attributes))
  }

  /**
   * @param {Array<{ context: object, attributes?: Record<string, unknown> }>} links
   * @returns {this}
   */
  addLinks (links) {
    for (const link of links) {
      this.addLink(link)
    }
    return this
  }

  /**
   * A thin wrapper over the `addLink` write path rather than its own event kind.
   *
   * @param {string} pointerKind
   * @param {string} pointerDirection
   * @param {string} pointerHash
   */
  addSpanPointer (pointerKind, pointerDirection, pointerHash) {
    getWriter().addLink(this._spanContext, ZERO_ID, serializeSpanPointer(
      pointerKind,
      pointerDirection,
      pointerHash
    ))
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown> | number} [attributesOrStartTime]
   * @param {number} [startTime]
   */
  addEvent (name, attributesOrStartTime, startTime) {
    let attributes
    if (attributesOrStartTime !== undefined) {
      if (attributesOrStartTime !== null && typeof attributesOrStartTime === 'object') {
        attributes = attributesOrStartTime
      } else {
        startTime = attributesOrStartTime
      }
    }

    getWriter().addEvent(
      this._spanContext,
      name,
      startTime ?? nowMillis(),
      attributes === undefined ? '' : serializeAttributes(attributes)
    )
  }

  /**
   * @param {number | string} [finishTime] A string is accepted because the baseline
   * `finish` runs the argument through `Number.parseFloat`, and callers rely on it.
   */
  finish (finishTime) {
    if (this.#finished) return
    this.#finished = true

    const context = this._spanContext
    const writer = getWriter()

    writer.setTagString(context, DD_INTEGRATION, this._integrationName)

    const finishMillis = finishTime === undefined
      ? nowMillis()
      : (Number.parseFloat(String(finishTime)) || nowMillis())

    writer.finish(context, this.#startHi, this.#startLo, finishMillis)
  }
}

Object.setPrototypeOf(NativeSpan.prototype, DatadogSpan.prototype)

let cachedTraceIdHighSecond = -1
let cachedTraceIdHighHex = ''

/**
 * The `_dd.p.tid` value: the start time in seconds, hex, occupying the top half
 * of the upper 64 trace-id bits. Same shape `span.js` produces, but memoised for
 * the current second — the value only changes once a second, and every local trace
 * root would otherwise pay four string operations to rebuild the same 16 characters.
 *
 * @param {number} startMillis
 * @returns {string}
 */
function traceIdHighHex (startMillis) {
  const second = Math.floor(startMillis / 1000)
  if (second !== cachedTraceIdHighSecond) {
    cachedTraceIdHighSecond = second
    cachedTraceIdHighHex = second.toString(16).padStart(8, '0').padEnd(16, '0')
  }
  return cachedTraceIdHighHex
}

/**
 * Convert a baseline `Identifier` — a byte buffer — into lanes, taking the low 8
 * bytes the way `Identifier#toArray()` does.
 *
 * @param {{ toBuffer: () => Uint8Array | number[] }} identifier
 * @returns {import('./id').NativeId}
 */
function identifierToNativeId (identifier) {
  const bytes = identifier.toBuffer()
  const start = bytes.length - 8
  const hi = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0
  const lo = ((bytes[start + 4] << 24) | (bytes[start + 5] << 16) |
    (bytes[start + 6] << 8) | bytes[start + 7]) >>> 0
  return new NativeId(hi, lo)
}

/**
 * The 128-bit trace id of a remote parent: the low 64 bits from its trace
 * `Identifier`, the upper 64 from the `_dd.p.tid` chunk tag propagation carried, if
 * the caller sent one.
 *
 * @param {{ _traceId: object, _trace?: { tags?: Record<string, string> } }} parent
 * @returns {import('./id').NativeId}
 */
function traceIdFromRemote (parent) {
  const traceId = identifierToNativeId(parent._traceId)
  const high = parent._trace?.tags?.[TRACE_ID_128]
  if (typeof high === 'string' && high.length === 16) {
    traceId.upperHi = Number.parseInt(high.slice(0, 8), 16)
    traceId.upperLo = Number.parseInt(high.slice(8), 16)
  }
  return traceId
}

/**
 * One `_dd.span_links` entry, serialized whole.
 *
 * The wire table gives `ADD_LINK` the target span id in lanes but no target trace
 * id, and a link entry needs one — so the entry is built here and interned as a
 * single string, with the lanes retained as the structured target.
 * A non-PoC version would carry the target trace id in the record and build this
 * JSON on the Rust side.
 *
 * @param {object} target
 * @param {Record<string, unknown>} [attributes]
 * @returns {string}
 */
function serializeLink (target, attributes) {
  const traceId = typeof target.toTraceId === 'function' ? target.toTraceId(true) : '0'.repeat(32)
  const spanId = typeof target.toSpanId === 'function' ? target.toSpanId(true) : '0'.repeat(16)
  let entry = `{"trace_id":"${traceId}","span_id":"${spanId}"`
  const serialized = attributes === undefined ? '' : serializeAttributes(attributes)
  if (serialized !== '') {
    entry += `,"attributes":${serialized}`
  }
  return `${entry}}`
}

/**
 * @param {string} pointerKind
 * @param {string} pointerDirection
 * @param {string} pointerHash
 * @returns {string}
 */
function serializeSpanPointer (pointerKind, pointerDirection, pointerHash) {
  return `{"trace_id":"${'0'.repeat(32)}","span_id":"${'0'.repeat(16)}","attributes":${JSON.stringify({
    'ptr.kind': pointerKind,
    'ptr.dir': pointerDirection,
    'ptr.hash': pointerHash,
    'link.kind': 'span-pointer',
  })}}`
}

/**
 * Sanitize and serialize link / event attributes in one pass. Returns the empty
 * string when nothing survives, so the caller interns id 0 — the reserved absent
 * string — instead of a `{}` nobody needs.
 *
 * @param {Record<string, unknown>} attributes
 * @returns {string}
 */
function serializeAttributes (attributes) {
  /** @type {Record<string, unknown> | undefined} */
  let sanitized
  for (const key of Object.keys(attributes)) {
    const value = attributes[key]
    if (Array.isArray(value)) {
      const kept = []
      for (const entry of value) {
        if (ALLOWED.has(typeof entry)) kept.push(entry)
      }
      sanitized ??= {}
      sanitized[key] = kept
    } else if (ALLOWED.has(typeof value)) {
      sanitized ??= {}
      sanitized[key] = value
    }
  }
  return sanitized === undefined ? '' : JSON.stringify(sanitized)
}

module.exports = NativeSpan
