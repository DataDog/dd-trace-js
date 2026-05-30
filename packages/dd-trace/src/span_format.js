'use strict'

const tags = require('../../../ext/tags')
const constants = require('./constants')
const {
  MAX_META_KEY_LENGTH,
  MAX_META_VALUE_LENGTH,
  MAX_METRIC_KEY_LENGTH,
} = require('./encode/tags-processors')
const id = require('./id')
const { isError } = require('./util')
const { registerExtraService } = require('./service-naming/extra-services')
const { TRACING_FIELD_NAME } = require('./process-tags')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const SAMPLING_RULE_DECISION = constants.SAMPLING_RULE_DECISION
const SAMPLING_LIMIT_DECISION = constants.SAMPLING_LIMIT_DECISION
const SAMPLING_AGENT_DECISION = constants.SAMPLING_AGENT_DECISION
const SPAN_SAMPLING_MECHANISM = constants.SPAN_SAMPLING_MECHANISM
const SPAN_SAMPLING_RULE_RATE = constants.SPAN_SAMPLING_RULE_RATE
const SPAN_SAMPLING_MAX_PER_SECOND = constants.SPAN_SAMPLING_MAX_PER_SECOND
const SAMPLING_MECHANISM_SPAN = constants.SAMPLING_MECHANISM_SPAN
const { MEASURED, BASE_SERVICE, ANALYTICS } = tags
const ORIGIN_KEY = constants.ORIGIN_KEY
const HOSTNAME_KEY = constants.HOSTNAME_KEY
const TOP_LEVEL_KEY = constants.TOP_LEVEL_KEY
const PROCESS_ID = constants.PROCESS_ID
// The pid is constant for the process lifetime; read it once, not per span.
const PID = process.pid
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE
const { IGNORE_OTEL_ERROR } = constants

/**
 * @typedef {object} FormattedSpan
 * @property {import('./id').Identifier} trace_id
 * @property {import('./id').Identifier} span_id
 * @property {import('./id').Identifier} parent_id
 * @property {string} name
 * @property {string} resource
 * @property {string | undefined} service
 * @property {string | undefined} type
 * @property {number} error
 * @property {Record<string, string>} meta
 * @property {Record<string, number>} metrics
 * @property {Record<string, unknown> | undefined} meta_struct
 * @property {number} start
 * @property {number} duration
 * @property {Array} links
 * @property {Array<SpanEvent> | undefined} span_events
 *
 * @typedef {object} SpanEvent Raw span event as stored on the span; the encoder
 *   layer derives `time_unix_nano` from `startTime` via `eventTimeNano`.
 * @property {string} name
 * @property {number} startTime Milliseconds with sub-millisecond precision.
 * @property {Record<string, string>} [attributes]
 */

// The tracer service is fixed for a tracer's lifetime, so its lowercased form
// is computed once per distinct service string instead of on every span. The
// map stays single-entry in practice; keying on the raw string keeps it
// correct when a second tracer (CI visibility) runs a different service.
const lowerCaseServiceCache = new Map()

/**
 * @param {string} service
 */
function lowerCaseService (service) {
  let lower = lowerCaseServiceCache.get(service)
  if (lower === undefined) {
    lower = service.toLowerCase()
    lowerCaseServiceCache.set(service, lower)
  }
  return lower
}

/**
 * Collects the meta / metrics / head writes the driver emits while it walks a
 * span once. The driver does the categorization and truncation; the sink only
 * stores. `ObjectSink` reproduces the formatted-span object the rest of the
 * exporter pipeline expects; the 0.4 encoder pairs the same driver with a
 * `ByteSink` that emits msgpack directly and never builds the object.
 *
 * @typedef {object} SpanSink
 * @property {(value: string) => void} setService
 * @property {(value: string) => void} setType
 * @property {(value: string) => void} setResource
 * @property {() => void} setError Flag the span as an error (error = 1).
 * @property {(events: Array<SpanEvent>) => void} setSpanEvents
 * @property {(key: string, value: string) => void} writeMeta
 * @property {(key: string, value: number) => void} writeMetric
 */

/**
 * @implements {SpanSink}
 */
class ObjectSink {
  /**
   * @param {import('./opentracing/span')} span
   */
  constructor (span) {
    this.span = formatSpan(span)
    this.meta = this.span.meta
    this.metrics = this.span.metrics
  }

  setService (value) { this.span.service = value }
  setType (value) { this.span.type = value }
  setResource (value) { this.span.resource = value }
  setError () { this.span.error = 1 }
  setSpanEvents (events) { this.span.span_events = events }
  writeMeta (key, value) { this.meta[key] = value }
  writeMetric (key, value) { this.metrics[key] = value }
}

function format (span, isFirstSpanInChunk = false, tagForFirstSpanInChunk = false) {
  const sink = new ObjectSink(span)
  walkSpan(span, sink, isFirstSpanInChunk, tagForFirstSpanInChunk)
  return sink.span
}

/**
 * Single pass over a finished span: emit span links, events, root / chunk
 * tags, and the categorized tag set through `sink`, in the exact order the
 * formatted-span object used to gain its keys. The order is load-bearing for
 * the 0.4 `ByteSink`, whose msgpack maps emit in call order.
 *
 * @param {import('./opentracing/span')} span
 * @param {SpanSink} sink
 * @param {boolean} isFirstSpanInChunk
 * @param {string | false} tagForFirstSpanInChunk
 */
function walkSpan (span, sink, isFirstSpanInChunk, tagForFirstSpanInChunk) {
  extractSpanLinks(sink, span)
  extractSpanEvents(sink, span)
  extractRootTags(sink, span)
  if (isFirstSpanInChunk) {
    extractChunkTags(sink, span, tagForFirstSpanInChunk)
  }
  extractTags(sink, span)
}

function formatSpan (span) {
  const spanContext = span.context()
  // Pre-initialise the `service`, `type`, and `span_events` slots so every
  // formatted span shares one V8 hidden class regardless of which optional
  // tags fire later. Downstream encoders gate on truthy values for each,
  // so `undefined` stays byte-identical on the msgpack wire.
  return {
    trace_id: spanContext._traceId,
    span_id: spanContext._spanId,
    parent_id: spanContext._parentId || id('0'),
    name: String(spanContext._name),
    resource: String(spanContext._name),
    service: undefined,
    type: undefined,
    error: 0,
    meta: {},
    meta_struct: span.meta_struct,
    metrics: {},
    start: Math.round(span._startTime * 1e6),
    duration: Math.round(span._duration * 1e6),
    span_events: undefined,
  }
}

/**
 * @param {SpanSink} sink
 * @param {{ sampleRate?: number, maxPerSecond?: number } | undefined} options
 */
function setSingleSpanIngestionTags (sink, options) {
  if (!options) return
  sink.writeMetric(SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN)
  const sampleRate = options.sampleRate
  if (typeof sampleRate === 'number') {
    sink.writeMetric(SPAN_SAMPLING_RULE_RATE, sampleRate)
  }
  const maxPerSecond = options.maxPerSecond
  if (typeof maxPerSecond === 'number') {
    sink.writeMetric(SPAN_SAMPLING_MAX_PER_SECOND, maxPerSecond)
  }
}

/**
 * @param {SpanSink} sink
 * @param {import('./opentracing/span')} span
 */
function extractSpanLinks (sink, span) {
  const links = span._links
  if (!links?.length) {
    return
  }
  // Build the `_dd.span_links` JSON directly. The trace / span ids are decimal
  // strings (no escaping); attributes are pre-sanitized to a string map and
  // `undefined` when empty, so they only need a presence check. Avoids the
  // throwaway array of formatted-link objects the previous `map` allocated.
  let serialized = '['
  for (let i = 0; i < links.length; i++) {
    if (i > 0) serialized += ','
    const { context, attributes } = links[i]
    serialized += `{"trace_id":"${context.toTraceId(true)}","span_id":"${context.toSpanId(true)}"`
    if (attributes !== undefined) {
      serialized += `,"attributes":${JSON.stringify(attributes)}`
    }
    if (context?._sampling?.priority >= 0) {
      serialized += `,"flags":${context._sampling.priority > 0 ? 1 : 0}`
    }
    if (context?._tracestate) {
      serialized += `,"tracestate":${JSON.stringify(context._tracestate.toString())}`
    }
    serialized += '}'
  }
  serialized += ']'
  if (serialized.length > MAX_META_VALUE_LENGTH) {
    serialized = `${serialized.slice(0, MAX_META_VALUE_LENGTH)}...`
  }
  sink.writeMeta('_dd.span_links', serialized)
}

/**
 * Hand the raw `_events` array to the encoder layer instead of copying it into
 * reshaped `{ name, time_unix_nano, attributes }` objects. Each encoder derives
 * `time_unix_nano` from `event.startTime` via `eventTimeNano` and drops empty
 * attribute objects itself, so the per-event allocation here is pure waste on
 * every event-bearing span.
 *
 * @param {SpanSink} sink
 * @param {import('./opentracing/span')} span
 */
function extractSpanEvents (sink, span) {
  if (!span._events?.length) {
    return
  }
  sink.setSpanEvents(span._events)
}

/**
 * @param {SpanSink} sink
 * @param {import('./opentracing/span')} span
 */
function extractTags (sink, span) {
  const context = span.context()
  const origin = context._trace.origin
  // TODO(BridgeAR)[31.03.2025]: Look into changing the way we store tags. Using
  // a map is likely faster short term.
  const tags = context.getTags()
  const hostname = context._hostname
  const priority = context._sampling.priority

  // Emit the span.kind-derived `_dd.measured` only when no explicit
  // `_dd.measured` tag follows in the loop below; the explicit tag is
  // last-write-wins, so guarding here keeps the key single-emit. A
  // forward-only byte sink then needs no per-key dedup.
  if (tags['span.kind'] && tags['span.kind'] !== 'internal' && tags[MEASURED] === undefined) {
    sink.writeMetric(MEASURED, 1)
  }

  const tracerService = lowerCaseService(span.tracer()._service)
  if (tags['service.name']?.toLowerCase() !== tracerService) {
    span.setTag(BASE_SERVICE, tracerService)

    registerExtraService(tags['service.name'])
  }

  for (const tag of Object.keys(tags)) {
    const value = tags[tag]
    // The typed-helper bodies are inlined per case: V8 was not inlining
    // `addStringTag` / `addNumberTag` / `addMixedTag` here at the call rate
    // this loop runs in HTTP-server traces (10+ tags × 1M spans/sec), so each
    // one paid an extra call frame the helper body was small enough to
    // expand inline.
    switch (tag) {
      case 'service.name':
        if (typeof value === 'string') {
          sink.setService(value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value)
        }
        break
      case 'span.type':
        if (typeof value === 'string') {
          sink.setType(value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value)
        }
        break
      case 'resource.name':
        if (typeof value === 'string') {
          sink.setResource(value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value)
        }
        break
      // HACK: remove when Datadog supports numeric status code
      case 'http.status_code': {
        const stringValue = value && String(value)
        if (typeof stringValue === 'string') {
          sink.writeMeta(tag, stringValue.length > MAX_META_VALUE_LENGTH
            ? `${stringValue.slice(0, MAX_META_VALUE_LENGTH)}...`
            : stringValue)
        }
        break
      }
      case 'analytics.event':
        sink.writeMetric(ANALYTICS, value === undefined || value ? 1 : 0)
        break
      case HOSTNAME_KEY:
      case MEASURED:
        sink.writeMetric(tag, value === undefined || value ? 1 : 0)
        break
      // TODO(BridgeAR)[31.03.2025]: How come we use two different ways to pass
      // through errors? Can we just unify the behavior to always use one way?
      case 'error':
        if (context._name !== 'fs.operation') {
          extractError(sink, value)
        }
        break
      case ERROR_TYPE:
      case ERROR_MESSAGE:
      case ERROR_STACK: {
        // HACK: remove when implemented in the backend
        if (context._name === 'fs.operation') break
        // otel.recordException should not influence trace.error
        if (!tags[IGNORE_OTEL_ERROR]) {
          sink.setError()
        }
        if (value != null) writeErrorMeta(sink, tag, value)
        break
      }
      default: {
        const valueType = typeof value
        if (valueType === 'string') {
          let writeKey = tag
          if (writeKey.length > MAX_META_KEY_LENGTH) {
            writeKey = `${writeKey.slice(0, MAX_META_KEY_LENGTH)}...`
          }
          sink.writeMeta(writeKey, value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value)
        } else if (valueType === 'number') {
          if (!Number.isNaN(value)) {
            let writeKey = tag
            if (writeKey.length > MAX_METRIC_KEY_LENGTH) {
              writeKey = `${writeKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
            }
            sink.writeMetric(writeKey, value)
          }
        } else if (valueType === 'boolean') {
          let writeKey = tag
          if (writeKey.length > MAX_METRIC_KEY_LENGTH) {
            writeKey = `${writeKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
          }
          sink.writeMetric(writeKey, value ? 1 : 0)
        } else {
          addMixedTag(sink, tag, value)
        }
      }
    }
  }
  setSingleSpanIngestionTags(sink, context._spanSampling)

  sink.writeMeta('language', 'javascript')
  sink.writeMetric(PROCESS_ID, PID)
  if (typeof priority === 'number') {
    sink.writeMetric(SAMPLING_PRIORITY_KEY, priority)
  }
  if (typeof origin === 'string') {
    sink.writeMeta(ORIGIN_KEY, origin.length > MAX_META_VALUE_LENGTH
      ? `${origin.slice(0, MAX_META_VALUE_LENGTH)}...`
      : origin)
  }
  if (typeof hostname === 'string') {
    sink.writeMeta(HOSTNAME_KEY, hostname.length > MAX_META_VALUE_LENGTH
      ? `${hostname.slice(0, MAX_META_VALUE_LENGTH)}...`
      : hostname)
  }
}

/**
 * @param {SpanSink} sink
 * @param {import('./opentracing/span')} span
 */
function extractRootTags (sink, span) {
  const context = span.context()
  const parentId = context._parentId

  if (span !== context._trace.started[0] || (parentId && parentId.toString(10) !== '0')) return

  const trace = context._trace
  const ruleDecision = trace[SAMPLING_RULE_DECISION]
  if (typeof ruleDecision === 'number') {
    sink.writeMetric(SAMPLING_RULE_DECISION, ruleDecision)
  }
  const limitDecision = trace[SAMPLING_LIMIT_DECISION]
  if (typeof limitDecision === 'number') {
    sink.writeMetric(SAMPLING_LIMIT_DECISION, limitDecision)
  }
  const agentDecision = trace[SAMPLING_AGENT_DECISION]
  if (typeof agentDecision === 'number') {
    sink.writeMetric(SAMPLING_AGENT_DECISION, agentDecision)
  }
  sink.writeMetric(TOP_LEVEL_KEY, 1)
}

/**
 * @param {SpanSink} sink
 * @param {import('./opentracing/span')} span
 * @param {string | false} tagForFirstSpanInChunk
 */
function extractChunkTags (sink, span, tagForFirstSpanInChunk) {
  if (typeof tagForFirstSpanInChunk === 'string') {
    sink.writeMeta(TRACING_FIELD_NAME, tagForFirstSpanInChunk.length > MAX_META_VALUE_LENGTH
      ? `${tagForFirstSpanInChunk.slice(0, MAX_META_VALUE_LENGTH)}...`
      : tagForFirstSpanInChunk)
  }

  // Chunk tags are always strings in production (`_dd.p.dm`, `_dd.p.tid`,
  // `_dd.p.ts`, `baggage.*`). Inline only the string branch; non-string
  // values fall through to `addMixedTag` so we don't carry duplicate
  // truncation logic for branches no real chunk tag ever takes.
  const traceTags = span.context()._trace.tags
  for (const key of Object.keys(traceTags)) {
    const value = traceTags[key]
    if (typeof value === 'string') {
      let writeKey = key
      if (writeKey.length > MAX_META_KEY_LENGTH) {
        writeKey = `${writeKey.slice(0, MAX_META_KEY_LENGTH)}...`
      }
      sink.writeMeta(writeKey, value.length > MAX_META_VALUE_LENGTH
        ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
        : value)
    } else {
      addMixedTag(sink, key, value)
    }
  }
}

/**
 * @param {SpanSink} sink
 * @param {unknown} error
 */
function extractError (sink, error) {
  if (!error) return

  sink.setError()

  if (isError(error)) {
    // AggregateError only has a code and no message.
    // TODO(BridgeAR)[31.03.2025]: An AggregateError can have a message. Should
    // the code just generally be added, if available?
    const message = error.message || error.code
    if (message != null) writeErrorMeta(sink, ERROR_MESSAGE, message)
    if (error.name != null) writeErrorMeta(sink, ERROR_TYPE, error.name)
    if (error.stack != null) writeErrorMeta(sink, ERROR_STACK, error.stack)
  }
}

/**
 * Coerces `value` to string and truncates at `MAX_META_VALUE_LENGTH` before
 * writing it to one of the three error meta fields.
 *
 * @param {SpanSink} sink
 * @param {string} key
 * @param {unknown} value
 */
function writeErrorMeta (sink, key, value) {
  const stringValue = typeof value === 'string' ? value : String(value)
  sink.writeMeta(key, stringValue.length > MAX_META_VALUE_LENGTH
    ? `${stringValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    : stringValue)
}

/**
 * Mixed-type dispatch retained for `extractError` and the slow-path fallback
 * inside the inlined per-tag loops in `extractTags` / `extractChunkTags`.
 * The scalar branches are kept here so a single `addMixedTag` call covers
 * recursion (nested object values) without re-entering the inlined paths.
 *
 * @param {SpanSink} sink
 * @param {string} key
 * @param {unknown} value
 * @param {boolean} [nested]
 */
function addMixedTag (sink, key, value, nested) {
  switch (typeof value) {
    case 'string':
      if (key.length > MAX_META_KEY_LENGTH) {
        key = `${key.slice(0, MAX_META_KEY_LENGTH)}...`
      }
      if (value.length > MAX_META_VALUE_LENGTH) {
        value = `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
      }
      sink.writeMeta(key, value)
      break
    case 'number':
      if (Number.isNaN(value)) break
      if (key.length > MAX_METRIC_KEY_LENGTH) {
        key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      }
      sink.writeMetric(key, value)
      break
    case 'boolean':
      if (key.length > MAX_METRIC_KEY_LENGTH) {
        key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      }
      sink.writeMetric(key, value ? 1 : 0)
      break
    default:
      if (value == null) break

      // Special case for Node.js Buffer and URL
      // TODO(BridgeAR)[31.03.2025]: Figure out if all typed arrays should be treated as buffers.
      if (isNodeBuffer(value) || isUrl(value)) {
        if (key.length > MAX_METRIC_KEY_LENGTH) {
          key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
        }
        sink.writeMetric(key, value.toString())
      } else if (!Array.isArray(value) && !nested) {
        for (const [prop, val] of Object.entries(value)) {
          addMixedTag(sink, `${key}.${prop}`, val, true)
        }
      }
  }
}

function isNodeBuffer (obj) {
  return obj.constructor && obj.constructor.name === 'Buffer' &&
    typeof obj.readInt8 === 'function' &&
    typeof obj.toString === 'function'
}

function isUrl (obj) {
  return obj.constructor && obj.constructor.name === 'URL' &&
    typeof obj.href === 'string' &&
    typeof obj.toString === 'function'
}

format.walkSpan = walkSpan
format.ObjectSink = ObjectSink

module.exports = format
