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

function format (span, isFirstSpanInChunk = false, tagForFirstSpanInChunk = false) {
  const formatted = formatSpan(span)

  extractSpanLinks(formatted, span)
  extractSpanEvents(formatted, span)
  extractRootTags(formatted, span)
  if (isFirstSpanInChunk) {
    extractChunkTags(formatted, span, tagForFirstSpanInChunk)
  }
  extractTags(formatted, span)

  return formatted
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

function setSingleSpanIngestionTags (formattedSpan, options) {
  if (!options) return
  const metrics = formattedSpan.metrics
  metrics[SPAN_SAMPLING_MECHANISM] = SAMPLING_MECHANISM_SPAN
  const sampleRate = options.sampleRate
  if (typeof sampleRate === 'number') {
    metrics[SPAN_SAMPLING_RULE_RATE] = sampleRate
  }
  const maxPerSecond = options.maxPerSecond
  if (typeof maxPerSecond === 'number') {
    metrics[SPAN_SAMPLING_MAX_PER_SECOND] = maxPerSecond
  }
}

/**
 * @param {FormattedSpan} formattedSpan
 * @param {import('./opentracing/span')} span
 */
function extractSpanLinks (formattedSpan, span) {
  const links = span._links
  if (!links?.length) {
    return
  }
  // Build the `_dd.span_links` JSON directly. The trace / span ids are decimal
  // strings (no escaping); attributes are pre-sanitized to a string map and
  // `undefined` when empty, so they only need a presence check. Avoids the
  // throwaway array of formatted-link objects the previous `map` allocated and
  // the second walk `JSON.stringify` does over them.
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
  formattedSpan.meta['_dd.span_links'] = serialized
}

/**
 * Hand the raw `_events` array to the encoder layer instead of copying it into
 * reshaped `{ name, time_unix_nano, attributes }` objects. Each encoder derives
 * `time_unix_nano` from `event.startTime` via `eventTimeNano` and drops empty
 * attribute objects itself, so the per-event allocation here is pure waste on
 * every event-bearing span.
 *
 * @param {FormattedSpan} formattedSpan
 * @param {import('./opentracing/span')} span
 */
function extractSpanEvents (formattedSpan, span) {
  if (!span._events?.length) {
    return
  }
  formattedSpan.span_events = span._events
}

function extractTags (formattedSpan, span) {
  const context = span.context()
  const origin = context._trace.origin
  // TODO(BridgeAR)[31.03.2025]: Look into changing the way we store tags. Using
  // a map is likely faster short term.
  const tags = context.getTags()
  const hostname = context._hostname
  const priority = context._sampling.priority
  const meta = formattedSpan.meta
  const metrics = formattedSpan.metrics

  if (tags['span.kind'] && tags['span.kind'] !== 'internal') {
    metrics[MEASURED] = 1
  }

  const tracerService = span.tracer().serviceLower
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
          formattedSpan.service = value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value
        }
        break
      case 'span.type':
        if (typeof value === 'string') {
          formattedSpan.type = value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value
        }
        break
      case 'resource.name':
        if (typeof value === 'string') {
          formattedSpan.resource = value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value
        }
        break
      // HACK: remove when Datadog supports numeric status code
      case 'http.status_code': {
        const stringValue = value && String(value)
        if (typeof stringValue === 'string') {
          meta[tag] = stringValue.length > MAX_META_VALUE_LENGTH
            ? `${stringValue.slice(0, MAX_META_VALUE_LENGTH)}...`
            : stringValue
        }
        break
      }
      case 'analytics.event':
        metrics[ANALYTICS] = value === undefined || value ? 1 : 0
        break
      case HOSTNAME_KEY:
      case MEASURED:
        metrics[tag] = value === undefined || value ? 1 : 0
        break
      // TODO(BridgeAR)[31.03.2025]: How come we use two different ways to pass
      // through errors? Can we just unify the behavior to always use one way?
      case 'error':
        if (context._name !== 'fs.operation') {
          extractError(formattedSpan, value)
        }
        break
      case ERROR_TYPE:
      case ERROR_MESSAGE:
      case ERROR_STACK: {
        // HACK: remove when implemented in the backend
        if (context._name === 'fs.operation') break
        // otel.recordException should not influence trace.error
        if (!tags[IGNORE_OTEL_ERROR]) {
          formattedSpan.error = 1
        }
        if (value != null) writeErrorMeta(meta, tag, value)
        break
      }
      default: {
        const valueType = typeof value
        if (valueType === 'string') {
          let writeKey = tag
          if (writeKey.length > MAX_META_KEY_LENGTH) {
            writeKey = `${writeKey.slice(0, MAX_META_KEY_LENGTH)}...`
          }
          meta[writeKey] = value.length > MAX_META_VALUE_LENGTH
            ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
            : value
        } else if (valueType === 'number') {
          if (!Number.isNaN(value)) {
            let writeKey = tag
            if (writeKey.length > MAX_METRIC_KEY_LENGTH) {
              writeKey = `${writeKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
            }
            metrics[writeKey] = value
          }
        } else if (valueType === 'boolean') {
          let writeKey = tag
          if (writeKey.length > MAX_METRIC_KEY_LENGTH) {
            writeKey = `${writeKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
          }
          metrics[writeKey] = value ? 1 : 0
        } else {
          addMixedTag(meta, metrics, tag, value)
        }
      }
    }
  }
  setSingleSpanIngestionTags(formattedSpan, context._spanSampling)

  meta.language = 'javascript'
  metrics[PROCESS_ID] = process.pid
  if (typeof priority === 'number') {
    metrics[SAMPLING_PRIORITY_KEY] = priority
  }
  if (typeof origin === 'string') {
    meta[ORIGIN_KEY] = origin.length > MAX_META_VALUE_LENGTH
      ? `${origin.slice(0, MAX_META_VALUE_LENGTH)}...`
      : origin
  }
  if (typeof hostname === 'string') {
    meta[HOSTNAME_KEY] = hostname.length > MAX_META_VALUE_LENGTH
      ? `${hostname.slice(0, MAX_META_VALUE_LENGTH)}...`
      : hostname
  }
}

function extractRootTags (formattedSpan, span) {
  const context = span.context()
  const parentId = context._parentId

  if (span !== context._trace.started[0] || (parentId && parentId.toString(10) !== '0')) return

  const trace = context._trace
  const metrics = formattedSpan.metrics
  const ruleDecision = trace[SAMPLING_RULE_DECISION]
  if (typeof ruleDecision === 'number') {
    metrics[SAMPLING_RULE_DECISION] = ruleDecision
  }
  const limitDecision = trace[SAMPLING_LIMIT_DECISION]
  if (typeof limitDecision === 'number') {
    metrics[SAMPLING_LIMIT_DECISION] = limitDecision
  }
  const agentDecision = trace[SAMPLING_AGENT_DECISION]
  if (typeof agentDecision === 'number') {
    metrics[SAMPLING_AGENT_DECISION] = agentDecision
  }
  // BUG: only the local root is tagged top-level. A child whose parent is in a different service is
  // also a service-entry (top-level) span and should be tagged here for client-side stats to be
  // correct (fails test_otlp_trace_metrics FR06.3).
  metrics[TOP_LEVEL_KEY] = 1
}

function extractChunkTags (formattedSpan, span, tagForFirstSpanInChunk) {
  const meta = formattedSpan.meta
  if (typeof tagForFirstSpanInChunk === 'string') {
    meta[TRACING_FIELD_NAME] = tagForFirstSpanInChunk.length > MAX_META_VALUE_LENGTH
      ? `${tagForFirstSpanInChunk.slice(0, MAX_META_VALUE_LENGTH)}...`
      : tagForFirstSpanInChunk
  }

  // Chunk tags are always strings in production (`_dd.p.dm`, `_dd.p.tid`,
  // `_dd.p.ts`, `baggage.*`). Inline only the string branch; non-string
  // values fall through to `addMixedTag` so we don't carry duplicate
  // truncation logic for branches no real chunk tag ever takes.
  const metrics = formattedSpan.metrics
  const traceTags = span.context()._trace.tags
  for (const key of Object.keys(traceTags)) {
    const value = traceTags[key]
    if (typeof value === 'string') {
      let writeKey = key
      if (writeKey.length > MAX_META_KEY_LENGTH) {
        writeKey = `${writeKey.slice(0, MAX_META_KEY_LENGTH)}...`
      }
      meta[writeKey] = value.length > MAX_META_VALUE_LENGTH
        ? `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
        : value
    } else {
      addMixedTag(meta, metrics, key, value)
    }
  }
}

function extractError (formattedSpan, error) {
  if (!error) return

  formattedSpan.error = 1

  if (isError(error)) {
    // AggregateError only has a code and no message.
    // TODO(BridgeAR)[31.03.2025]: An AggregateError can have a message. Should
    // the code just generally be added, if available?
    const meta = formattedSpan.meta
    const message = error.message || error.code
    if (message != null) writeErrorMeta(meta, ERROR_MESSAGE, message)
    if (error.name != null) writeErrorMeta(meta, ERROR_TYPE, error.name)
    if (error.stack != null) writeErrorMeta(meta, ERROR_STACK, error.stack)
  }
}

/**
 * Coerces `value` to string and truncates at `MAX_META_VALUE_LENGTH` before
 * writing it to one of the three error meta fields.
 *
 * @param {Record<string, string>} meta
 * @param {string} key
 * @param {unknown} value
 */
function writeErrorMeta (meta, key, value) {
  const stringValue = typeof value === 'string' ? value : String(value)
  meta[key] = stringValue.length > MAX_META_VALUE_LENGTH
    ? `${stringValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    : stringValue
}

/**
 * Mixed-type dispatch retained for `extractError` and the slow-path fallback
 * inside the inlined per-tag loops in `extractTags` / `extractChunkTags`.
 * The scalar branches are kept here so a single `addMixedTag` call covers
 * recursion (nested object values) without re-entering the inlined paths.
 *
 * @param {Record<string, string>} meta
 * @param {Record<string, number>} metrics
 * @param {string} key
 * @param {unknown} value
 * @param {boolean} [nested]
 */
function addMixedTag (meta, metrics, key, value, nested) {
  switch (typeof value) {
    case 'string':
      if (key.length > MAX_META_KEY_LENGTH) {
        key = `${key.slice(0, MAX_META_KEY_LENGTH)}...`
      }
      if (value.length > MAX_META_VALUE_LENGTH) {
        value = `${value.slice(0, MAX_META_VALUE_LENGTH)}...`
      }
      meta[key] = value
      break
    case 'number':
      if (Number.isNaN(value)) break
      if (key.length > MAX_METRIC_KEY_LENGTH) {
        key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      }
      metrics[key] = value
      break
    case 'boolean':
      if (key.length > MAX_METRIC_KEY_LENGTH) {
        key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      }
      metrics[key] = value ? 1 : 0
      break
    default:
      if (value == null) break

      // Special case for Node.js Buffer and URL
      // TODO(BridgeAR)[31.03.2025]: Figure out if all typed arrays should be treated as buffers.
      if (isNodeBuffer(value) || isUrl(value)) {
        if (key.length > MAX_METRIC_KEY_LENGTH) {
          key = `${key.slice(0, MAX_METRIC_KEY_LENGTH)}...`
        }
        metrics[key] = value.toString()
      } else if (!Array.isArray(value) && !nested) {
        for (const [prop, val] of Object.entries(value)) {
          addMixedTag(meta, metrics, `${key}.${prop}`, val, true)
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

module.exports = format
