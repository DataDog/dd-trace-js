'use strict'

const Int64BE = require('int64-buffer').Int64BE
const constants = require('./constants')
const tags = require('../../../ext/tags')
const log = require('./log')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const ANALYTICS_KEY = constants.ANALYTICS_KEY
const ANALYTICS = tags.ANALYTICS
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
  extractTags(formatted, span)
  extractMetrics(formatted, span)
  extractAnalytics(formatted, span)

  return formatted
}

function formatSpan (span) {
  const spanContext = span.context()

  return {
    trace_id: spanContext._traceId.toUint64BE(),
    span_id: spanContext._spanId.toUint64BE(),
    parent_id: spanContext._parentId ? spanContext._parentId.toUint64BE() : null,
    name: serialize(spanContext._name),
    resource: serialize(spanContext._name),
    error: 0,
    meta: {},
    metrics: {},
    start: new Int64BE(Math.round(span._startTime * 1e6)),
    duration: new Int64BE(Math.round(span._duration * 1e6))
  }
}

function extractTags (trace, span) {
  const origin = span.context()._trace.origin
  const tags = span.context()._tags
  const hostname = span.context()._hostname

  Object.keys(tags).forEach(tag => {
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        addTag(trace, map[tag], tags[tag])
        break
      case HOSTNAME_KEY:
      case ANALYTICS:
        break
      case 'error':
        if (tags[tag]) {
          trace.error = 1
        }
        break
      case 'error.type':
      case 'error.msg':
      case 'error.stack':
        trace.error = 1
      default: // eslint-disable-line no-fallthrough
        addTag(trace.meta, tag, tags[tag])
    }
  })

  if (origin) {
    addTag(trace.meta, ORIGIN_KEY, origin)
  }

  if (span.tracer()._service === tags['service.name']) {
    addTag(trace.meta, 'language', 'javascript')
  }

  addTag(trace.meta, HOSTNAME_KEY, hostname)
}

function extractError (trace, span) {
  const error = span.context()._tags['error']

  if (error instanceof Error) {
    trace.meta['error.msg'] = error.message
    trace.meta['error.type'] = error.name
    trace.meta['error.stack'] = error.stack
  }
}

function extractMetrics (trace, span) {
  const spanContext = span.context()

  Object.keys(spanContext._metrics).forEach(metric => {
    if (typeof spanContext._metrics[metric] === 'number') {
      trace.metrics[metric] = spanContext._metrics[metric]
    }
  })

  if (spanContext._sampling.priority !== undefined) {
    trace.metrics[SAMPLING_PRIORITY_KEY] = spanContext._sampling.priority
  }
}

function extractAnalytics (trace, span) {
  let analytics = span.context()._tags[ANALYTICS]

  if (analytics === true) {
    analytics = 1
  } else {
    analytics = parseFloat(analytics)
  }

  if (!isNaN(analytics)) {
    trace.metrics[ANALYTICS_KEY] = Math.max(Math.min(analytics, 1), 0)
  }
}

function addTag (meta, key, value, seen) {
  switch (typeof value) {
    case 'string':
      meta[key] = value
      break
    case 'undefined':
      break
    case 'object':
      if (value === null) break

      if (!Array.isArray(value)) {
        addObjectTag(meta, key, value, seen)
        break
      }

    default: // eslint-disable-line no-fallthrough
      addTag(meta, key, serialize(value))
  }
}

function addObjectTag (meta, key, value, seen) {
  seen = seen || []

  if (~seen.indexOf(value)) {
    meta[key] = '[Circular]'
    return
  }

  seen.push(value)

  Object.keys(value).forEach(prop => {
    addTag(meta, `${key}.${prop}`, value[prop], seen)
  })

  seen.pop()
}

function serialize (obj) {
  try {
    return obj && typeof obj.toString !== 'function' ? JSON.stringify(obj) : String(obj)
  } catch (e) {
    log.error(e)
  }
}

module.exports = format
