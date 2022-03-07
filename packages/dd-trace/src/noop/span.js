'use strict'

const Span = require('opentracing').Span
const noop = require('../../../datadog-tracer/src/noop')
const SpanContext = require('../opentracing/span_context')

class NoopSpan extends Span {
  constructor (tracer) {
    super()

    const span = noop.tracer.startSpan()

    this._parentTracer = tracer
    this._spanContext = new SpanContext(span)
  }

  _context () {
    return this._spanContext
  }

  _tracer () {
    return this._parentTracer
  }
}

module.exports = NoopSpan
