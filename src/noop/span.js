'use strict'

const Span = require('opentracing').Span
const context = require('./span_context')

class NoopSpan extends Span {
  _context () {
    return context
  }
}

module.exports = new NoopSpan()
