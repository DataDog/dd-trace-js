'use strict'

const Span = require('opentracing').Span
const context = require('./span_context')

let tracer

class NoopSpan extends Span {
  _context () {
    return context
  }

  _tracer () {
    // lazy load to avoid circular dependency
    return (tracer || (tracer = require('../..')))._tracer
  }
}

module.exports = new NoopSpan()
