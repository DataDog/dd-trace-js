'use strict'

const constants = require('./constants')
const tags = require('../../../ext/tags')
const id = require('./id')
const { isError } = require('./util')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const SAMPLING_RULE_DECISION = constants.SAMPLING_RULE_DECISION
const SAMPLING_LIMIT_DECISION = constants.SAMPLING_LIMIT_DECISION
const SAMPLING_AGENT_DECISION = constants.SAMPLING_AGENT_DECISION
const MEASURED = tags.MEASURED
const ORIGIN_KEY = constants.ORIGIN_KEY
const HOSTNAME_KEY = constants.HOSTNAME_KEY

const map = {
  'service.name': 'service',
  'span.type': 'type',
  'resource.name': 'resource'
}

function format (span) {
  const formatted = formatSpan(span)

  extractError(formatted, span)
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
    metrics: {},
    start: Math.round(span._startTime * 1e6),
    duration: Math.round(span._duration * 1e6)
  }
}

function extractTags (trace, span) {
  const context = span.context()
  const origin = context._trace.origin
  const tags = context._tags
  const hostname = context._hostname
  const priority = context._sampling.priority
  const internalErrors = span.tracer()._internalErrors

  if (tags['span.kind'] && tags['span.kind'] !== 'internal') {
    addTag({}, trace.metrics, MEASURED, 1)
  }

  for (const tag in tags) {
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        addTag(trace, {}, map[tag], tags[tag])
        break
      // HACK: remove when Datadog supports numeric status code
      case 'http.status_code':
        addTag(trace.meta, {}, tag, tags[tag] && String(tags[tag]))
        break
      case HOSTNAME_KEY:
      case MEASURED:
        addTag({}, trace.metrics, tag, tags[tag] === undefined || tags[tag] ? 1 : 0)
        break
      case 'error':
        if (tags[tag] && (context._name !== 'fs.operation' || internalErrors)) {
          trace.error = 1
        }
        break
      case 'error.type':
      case 'error.msg':
      case 'error.stack':
        // HACK: remove when implemented in the backend
        if (context._name !== 'fs.operation' || internalErrors) {
          trace.error = 1
        }
      default: // eslint-disable-line no-fallthrough
        addTag(trace.meta, trace.metrics, tag, tags[tag])
    }
  }

  if (span.tracer()._service === tags['service.name']) {
    addTag(trace.meta, trace.metrics, 'language', 'javascript')
  }

  addTag(trace.meta, trace.metrics, SAMPLING_PRIORITY_KEY, priority)
  addTag(trace.meta, trace.metrics, ORIGIN_KEY, origin)
  addTag(trace.meta, trace.metrics, HOSTNAME_KEY, hostname)
}

function extractRootTags (trace, span) {
  const context = span.context()
  const isLocalRoot = span === context._trace.started[0]
  const parentId = context._parentId

  if (!isLocalRoot || (parentId && parentId.toString(10) !== '0')) return

  addTag({}, trace.metrics, SAMPLING_RULE_DECISION, context._trace[SAMPLING_RULE_DECISION])
  addTag({}, trace.metrics, SAMPLING_LIMIT_DECISION, context._trace[SAMPLING_LIMIT_DECISION])
  addTag({}, trace.metrics, SAMPLING_AGENT_DECISION, context._trace[SAMPLING_AGENT_DECISION])
}

function extractChunkTags (trace, span) {
  const context = span.context()
  const isLocalRoot = span === context._trace.started[0]

  if (!isLocalRoot) return

  for (const key in context._trace.tags) {
    addTag(trace.meta, trace.metrics, key, context._trace.tags[key])
  }
}

function extractError (trace, span) {
  const error = span.context()._tags['error']
  if (isError(error)) {
    addTag(trace.meta, trace.metrics, 'error.msg', error.message)
    addTag(trace.meta, trace.metrics, 'error.type', error.name)
    addTag(trace.meta, trace.metrics, 'error.stack', error.stack)
  }
}

function addTag (meta, metrics, key, value, nested) {
  switch (typeof value) {
    case 'string':
      if (!value) break
      meta[key] = value
      break
    case 'number':
      if (isNaN(value)) break
      metrics[key] = value
      break
    case 'boolean':
      metrics[key] = value ? 1 : 0
      break
    case 'undefined':
      break
    case 'object':
      if (value === null) break

      // Special case for Node.js Buffer and URL
      if (isNodeBuffer(value) || isUrl(value)) {
        metrics[key] = value.toString()
      } else if (!Array.isArray(value) && !nested) {
        for (const prop in value) {
          if (!value.hasOwnProperty(prop)) continue

          addTag(meta, metrics, `${key}.${prop}`, value[prop], true)
        }
      }

      break
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
