'use strict'

const Tracer = require('opentracing').Tracer
const NoopTracer = require('./noop')
const DatadogTracer = require('./tracer')

const noop = new NoopTracer()
let tracer = noop

class TracerProxy extends Tracer {
  init (config) {
    if (tracer === noop) {
      tracer = new DatadogTracer(config)
    }

    return this
  }

  trace () {
    return tracer.trace.apply(tracer, arguments)
  }

  startSpan () {
    return tracer.startSpan.apply(tracer, arguments)
  }

  inject () {
    return tracer.inject.apply(tracer, arguments)
  }

  extract () {
    return tracer.extract.apply(tracer, arguments)
  }
}

module.exports = TracerProxy
