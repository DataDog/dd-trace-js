'use strict'

const Int64BE = require('int64-buffer').Int64BE
const constants = require('./constants')

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
  const tracer = span.tracer()
  const spanContext = span.context()

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    parent_id: spanContext.parentId,
    name: String(span._operationName),
    resource: String(span._operationName),
    service: String(tracer._service),
    error: 0,
    meta: {},
    metrics: {},
    start: new Int64BE(Math.round(span._startTime * 1e6)),
    duration: new Int64BE(Math.round(span._duration * 1e6))
  }
}

function extractTags (trace, span) {
  const tags = span.context().tags

  Object.keys(tags).forEach(tag => {
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        trace[map[tag]] = String(tags[tag])
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
        trace.meta[tag] = String(tags[tag])
        break
      default:
        trace.meta[tag] = String(tags[tag])
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

  Object.keys(spanContext.metrics).forEach(metric => {
    if (typeof spanContext.metrics[metric] === 'number') {
      trace.metrics[metric] = spanContext.metrics[metric]
    }
  })

  if (spanContext.sampling.priority !== undefined) {
    trace.metrics[SAMPLING_PRIORITY_KEY] = spanContext.sampling.priority
  }
}

module.exports = format
