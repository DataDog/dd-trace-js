'use strict'

const constants = require('./constants')
const tags = require('../../../ext/tags')
const id = require('./id')
const { isError } = require('./util')
const { registerExtraService } = require('./service-naming/extra-services')

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

// TODO(BridgeAR)[31.03.2025]: Should these land in the constants file?
const map = {
  'operation.name': 'name',
  'service.name': 'service',
  'span.type': 'type',
  'resource.name': 'resource'
}

function format (span) {
  const formatted = formatSpan(span)

  extractSpanLinks(formatted, span)
  extractSpanEvents(formatted, span)
  extractRootTags(formatted, span)
  extractChunkTags(formatted, span)
  extractTags(formatted, span)

  return formatted
}

function formatSpan (span) {
  const spanContext = span.context()

  return {
    trace_id: spanContext._traceId,
    span_id: spanContext._spanId,
    parent_id: spanContext._parentId || id('0'),
    name: String(spanContext._name),
    resource: String(spanContext._name),
    error: 0,
    meta: {},
    meta_struct: span.meta_struct,
    metrics: {},
    start: Math.round(span._startTime * 1e6),
    duration: Math.round(span._duration * 1e6),
    links: []
  }
}

function setSingleSpanIngestionTags (span, options) {
  if (!options) return
  addTag({}, span.metrics, SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN)
  addTag({}, span.metrics, SPAN_SAMPLING_RULE_RATE, options.sampleRate)
  addTag({}, span.metrics, SPAN_SAMPLING_MAX_PER_SECOND, options.maxPerSecond)
}

function extractSpanLinks (trace, span) {
  if (!span._links?.length) {
    return
  }
  const links = []
  for (const link of span._links) {
    const { context, attributes } = link
    const formattedLink = {
      trace_id: context.toTraceId(true),
      span_id: context.toSpanId(true)
    }

    if (attributes && Object.keys(attributes).length > 0) {
      formattedLink.attributes = attributes
    }
    if (context?._sampling?.priority >= 0) formattedLink.flags = context._sampling.priority > 0 ? 1 : 0
    if (context?._tracestate) formattedLink.tracestate = context._tracestate.toString()

    links.push(formattedLink)
  }
  trace.meta['_dd.span_links'] = JSON.stringify(links)
}

function extractSpanEvents (trace, span) {
  if (!span._events?.length) {
    return
  }
  const events = []
  for (const event of span._events) {
    const formattedEvent = {
      name: event.name,
      time_unix_nano: Math.round(event.startTime * 1e6),
      attributes: event.attributes && Object.keys(event.attributes).length > 0 ? event.attributes : undefined
    }

    events.push(formattedEvent)
  }
  trace.meta.events = JSON.stringify(events)
}

function extractTags (trace, span) {
  const context = span.context()
  const origin = context._trace.origin
  // TODO(BridgeAR)[31.03.2025]: Look into changing the way we store tags. Using
  // a map is likely faster short term.
  const tags = context._tags
  const hostname = context._hostname
  const priority = context._sampling.priority

  if (tags['span.kind'] && tags['span.kind'] !== 'internal') {
    addTag({}, trace.metrics, MEASURED, 1)
  }

  const tracerService = span.tracer()._service.toLowerCase()
  if (tags['service.name']?.toLowerCase() !== tracerService) {
    span.setTag(BASE_SERVICE, tracerService)

    registerExtraService(tags['service.name'])
  }

  for (const [tag, value] of Object.entries(tags)) {
    // TODO(BridgeAR)[31.03.2025]: Check how many tags are defined in average.
    // In case there are more than 2 tags in average, check for all special
    // cases up front and loop over the tags afterwards, skipping the already
    // visited property names by checking a map with these keys.
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        addTag(trace, {}, map[tag], value)
        break
      // HACK: remove when Datadog supports numeric status code
      case 'http.status_code':
        addTag(trace.meta, {}, tag, value && String(value))
        break
      case 'analytics.event':
        addTag({}, trace.metrics, ANALYTICS, value === undefined || value ? 1 : 0)
        break
      case HOSTNAME_KEY:
      case MEASURED:
        addTag({}, trace.metrics, tag, value === undefined || value ? 1 : 0)
        break
      // TODO(BridgeAR)[31.03.2025]: How come we use two different ways to pass
      // through errors? Can we just unify the behavior to always use one way?
      case 'error':
        if (context._name !== 'fs.operation') {
          extractError(trace, value)
        }
        break
      case ERROR_TYPE:
      case ERROR_MESSAGE:
      case ERROR_STACK:
        // HACK: remove when implemented in the backend
        if (context._name === 'fs.operation') {
          break
        }
        // otel.recordException should not influence trace.error
        if (!tags[IGNORE_OTEL_ERROR]) {
          trace.error = 1
        }
      default: // eslint-disable-line no-fallthrough
        addTag(trace.meta, trace.metrics, tag, value)
    }
  }
  setSingleSpanIngestionTags(trace, context._spanSampling)

  addTag(trace.meta, trace.metrics, 'language', 'javascript')
  addTag(trace.meta, trace.metrics, PROCESS_ID, process.pid)
  addTag(trace.meta, trace.metrics, SAMPLING_PRIORITY_KEY, priority)
  addTag(trace.meta, trace.metrics, ORIGIN_KEY, origin)
  addTag(trace.meta, trace.metrics, HOSTNAME_KEY, hostname)
}

function extractRootTags (trace, span) {
  const context = span.context()
  const isLocalRoot = span === context._trace.started[0]
  const parentId = context._parentId

  if (!isLocalRoot || (parentId && parentId !== '0')) return

  addTag({}, trace.metrics, SAMPLING_RULE_DECISION, context._trace[SAMPLING_RULE_DECISION])
  addTag({}, trace.metrics, SAMPLING_LIMIT_DECISION, context._trace[SAMPLING_LIMIT_DECISION])
  addTag({}, trace.metrics, SAMPLING_AGENT_DECISION, context._trace[SAMPLING_AGENT_DECISION])
  addTag({}, trace.metrics, TOP_LEVEL_KEY, 1)
}

function extractChunkTags (trace, span) {
  const context = span.context()
  const isLocalRoot = span === context._trace.started[0]

  if (!isLocalRoot) return

  for (const [key, value] of Object.entries(context._trace.tags)) {
    addTag(trace.meta, trace.metrics, key, value)
  }
}

function extractError (trace, error) {
  if (!error) return

  trace.error = 1

  if (isError(error)) {
    // AggregateError only has a code and no message.
    // TODO(BridgeAR)[31.03.2025]: An AggregateError can have a message. Should
    // the code just generally be added, if available?
    addTag(trace.meta, trace.metrics, ERROR_MESSAGE, error.message || error.code)
    addTag(trace.meta, trace.metrics, ERROR_TYPE, error.name)
    addTag(trace.meta, trace.metrics, ERROR_STACK, error.stack)
  }
}

function addTag (meta, metrics, key, value, nested) {
  switch (typeof value) {
    case 'string':
      meta[key] = value
      break
    case 'number':
      if (isNaN(value)) break
      metrics[key] = value
      break
    case 'boolean':
      metrics[key] = value ? 1 : 0
      break
    default:
      if (value == null) break

      // Special case for Node.js Buffer and URL
      // TODO(BridgeAR)[31.03.2025]: Figure out if all typed arrays should be treated as buffers.
      if (isNodeBuffer(value) || isUrl(value)) {
        metrics[key] = value.toString()
      } else if (!Array.isArray(value) && !nested) {
        for (const [prop, val] of Object.entries(value)) {
          addTag(meta, metrics, `${key}.${prop}`, val, true)
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
