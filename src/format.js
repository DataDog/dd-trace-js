'use strict'

const Int64BE = require('int64-buffer').Int64BE
const constants = require('./constants')
const tags = require('../ext/tags')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const EVENT_SAMPLE_RATE_KEY = constants.EVENT_SAMPLE_RATE_KEY
const EVENT_SAMPLE_RATE = tags.EVENT_SAMPLE_RATE

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
    name: String(spanContext._name),
    resource: String(spanContext._name),
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
      case EVENT_SAMPLE_RATE:
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
  const eventSampleRate = parseFloat(spanContext._tags[EVENT_SAMPLE_RATE])

  Object.keys(spanContext._metrics).forEach(metric => {
    if (typeof spanContext._metrics[metric] === 'number') {
      trace.metrics[metric] = spanContext._metrics[metric]
    }
  })

  if (spanContext._sampling.priority !== undefined) {
    trace.metrics[SAMPLING_PRIORITY_KEY] = spanContext._sampling.priority
  }

  if (eventSampleRate >= 0 && eventSampleRate <= 1) {
    trace.metrics[EVENT_SAMPLE_RATE_KEY] = eventSampleRate
  }
}

module.exports = format
