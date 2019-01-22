'use strict'

const SpanContext = require('opentracing').SpanContext

class NoopSpanContext extends SpanContext {
  toTraceId () {
    return ''
  }

  toSpanId () {
    return ''
  }
}

module.exports = NoopSpanContext
