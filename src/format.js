'use strict'

const Uint64BE = require('int64-buffer').Uint64BE

const map = {
  'service.name': 'service',
  'span.type': 'type',
  'resource.name': 'resource'
}

function format (span) {
  const formatted = formatSpan(span)

  extractTags(formatted, span._tags)
  extractError(formatted, span._error)

  return formatted
}

function formatSpan (span) {
  const tracer = span.tracer()
  const spanContext = span.context()

  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    parent_id: spanContext.parentId,
    name: span._operationName,
    service: tracer._service,
    error: 0,
    meta: {},
    start: new Uint64BE(Math.round(span._startTime * 1e6)),
    duration: new Uint64BE(Math.round(span._duration * 1e6))
  }
}

function extractTags (trace, tags) {
  Object.keys(tags).forEach(tag => {
    switch (tag) {
      case 'service.name':
      case 'span.type':
      case 'resource.name':
        trace[map[tag]] = tags[tag]
        break
      default:
        trace.meta[tag] = tags[tag]
    }
  })
}

function extractError (trace, error) {
  if (error) {
    trace.error = 1
    trace.meta['error.msg'] = error.message
    trace.meta['error.type'] = error.name
    trace.meta['error.stack'] = error.stack
  }
}

module.exports = format
