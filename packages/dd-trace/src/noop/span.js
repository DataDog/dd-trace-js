'use strict'

const Span = require('opentracing').Span
const SpanContext = require('../opentracing/span_context')
const priority = require('../../../../ext/priority')
const platform = require('../platform')

const USER_REJECT = priority.USER_REJECT

class NoopSpan extends Span {
  constructor (tracer, parent) {
    super()

    // Avoid circular dependency
    Object.defineProperties(this, {
      _noopTracer: {
        value: tracer
      },

      _noopContext: {
        value: this._createContext(parent)
      }
    })
  }

  _context () {
    return this._noopContext
  }

  _tracer () {
    return this._noopTracer
  }

  _createContext (parent) {
    const spanId = platform.id()

    let traceId
    let parentId
    let baggageItems

    if (parent) {
      traceId = parent._traceId
      parentId = parent._traceId
      baggageItems = parent._baggageItems
    } else {
      traceId = spanId
      parentId = null
      baggageItems = {}
    }

    return new SpanContext({
      noop: this,
      traceId,
      spanId,
      parentId,
      baggageItems,
      traceFlags: {
        sampled: false
      },
      sampling: {
        priority: USER_REJECT
      }
    })
  }
}

module.exports = NoopSpan
