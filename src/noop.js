'use strict'

const Tracer = require('opentracing').Tracer

class NoopTracer extends Tracer {
  trace () {
    return this.startSpan()
  }
}

module.exports = NoopTracer
