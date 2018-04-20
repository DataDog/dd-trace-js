'use strict'

const Tracer = require('opentracing').Tracer

class NoopTracer extends Tracer {
  use (plugin, config) {
    return this
  }

  trace (operationName, options, callback) {
    callback(this.startSpan())
  }

  currentSpan () {
    return null
  }

  bind (callback) {}

  bindEmitter (emitter) {}
}

module.exports = NoopTracer
