'use strict'

const SpanContext = require('../opentracing/span_context')

module.exports = new SpanContext({
  traceId: 0,
  spanId: 0
})
