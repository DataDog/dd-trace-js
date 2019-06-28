'use strict'

const Span = require('opentracing').Span
const SpanContext = require('../opentracing/span_context')
const priority = require('../../../../ext/priority')
const platform = require('../platform')

const USER_REJECT = priority.USER_REJECT

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
          traceId: platform.id('0', 10),
          spanId: platform.id('0', 10),
          traceFlags: {
            sampled: false
          },
          sampling: {
            priority: USER_REJECT
          }
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
