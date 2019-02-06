'use strict'

const SpanContext = require('opentracing').SpanContext

class NoopSpanContext extends SpanContext {
  toTraceId () {
    return '0'
  }

  toSpanId () {
    return '0'
  }
}

module.exports = NoopSpanContext
