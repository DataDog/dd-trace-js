'use strict'

const Int64BE = require('int64-buffer').Int64BE

const map = {
  'service.name': 'service',
  'span.type': 'type',
  'resource.name': 'resource'
}

function format (span) {
  const formatted = formatSpan(span)

  extractError(formatted, span._error)
  extractTags(formatted, span._tags)

  return formatted
}

function formatSpan (span) {
  const tracer = span.tracer()
  const spanContext = span.context()

  const metrics = {}
  if (spanContext.samplingPriority !== undefined) {
    metrics['_sampling_priority_v1'] = spanContext.samplingPriority
  }

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    parent_id: spanContext.parentId,
    name: String(span._operationName),
    resource: String(span._operationName),
    service: String(tracer._service),
    error: 0,
    meta: {},
    metrics,
    start: new Int64BE(Math.round(span._startTime * 1e6)),
    duration: new Int64BE(Math.round(span._duration * 1e6))
  }
}

function extractTags (trace, tags) {
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

function extractError (trace, error) {
  if (error) {
    trace.meta['error.msg'] = error.message
    trace.meta['error.type'] = error.name
    trace.meta['error.stack'] = error.stack
  }
}

module.exports = format
