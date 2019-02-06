'use strict'

const Span = require('opentracing').Span
const SpanContext = require('./span_context')

const context = new SpanContext()

class NoopSpan extends Span {
  _context () {
    return context
  }
}

module.exports = NoopSpan
