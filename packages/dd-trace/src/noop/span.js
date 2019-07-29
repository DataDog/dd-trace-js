'use strict'

const Span = require('opentracing').Span
const NoopSpanContext = require('../noop/span_context')
const platform = require('../platform')

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

    if (parent) {
      return new NoopSpanContext({
        noop: this,
        traceId: parent._traceId,
        spanId,
        parentId: parent._spanId,
        baggageItems: parent._baggageItems
      })
    } else {
      return new NoopSpanContext({
        noop: this,
        traceId: spanId,
        spanId
      })
    }
  }
}

module.exports = NoopSpan
