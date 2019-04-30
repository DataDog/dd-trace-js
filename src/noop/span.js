'use strict'

const Span = require('opentracing').Span
const SpanContext = require('../opentracing/span_context')

class NoopSpan extends Span {
  constructor (tracer) {
    super()

    // Avoid circular dependency
    Object.defineProperties(this, {
      _noopTracer: {
        value: tracer
      },

      _noopContext: {
        value: new SpanContext({
          traceId: 0,
          spanId: 0
        })
      }
    })
  }

  _context () {
    return this._noopContext
  }

  _tracer () {
    return this._noopTracer
  }
}

module.exports = NoopSpan
