'use strict'

const Int64BE = require('int64-buffer').Int64BE
const constants = require('./constants')
const log = require('./log')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY

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

  return formatted
}

function formatSpan (span) {
  const spanContext = span.context()

  return {
    trace_id: spanContext._traceId,
    span_id: spanContext._spanId,
    parent_id: spanContext._parentId,
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
  const tags = span.context()._tags

  Object.keys(tags).forEach(tag => {
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        addTag(trace, map[tag], tags[tag])
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
}

function extractError (trace, span) {
  const error = span._error

  if (error) {
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

function addTag (meta, key, value) {
  value = serialize(value)

  if (typeof value === 'string') {
    meta[key] = value
  }
}

function serialize (obj) {
  try {
    return obj && typeof obj.toString !== 'function' ? JSON.stringify(obj) : String(obj)
  } catch (e) {
    log.error(e)
  }
}

module.exports = format
