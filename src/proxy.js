'use strict'

const Tracer = require('opentracing').Tracer
const NoopTracer = require('./noop')
const DatadogTracer = require('./tracer')
const Config = require('./config')

const noop = new NoopTracer()
let tracer = noop

class TracerProxy extends Tracer {
  init (options) {
    if (tracer === noop) {
      const config = new Config(options)
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
