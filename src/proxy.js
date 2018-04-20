'use strict'

const Tracer = require('opentracing').Tracer
const NoopTracer = require('./noop')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const platform = require('./platform')

const noop = new NoopTracer()

class TracerProxy extends Tracer {
  constructor () {
    super()
    this._tracer = noop
  }

  init (options) {
    if (this._tracer === noop) {
      platform.load()

      const config = new Config(options)
      this._tracer = new DatadogTracer(config)
    }

    return this
  }

  use () {
    return this._tracer.use.apply(this._tracer, arguments)
  }

  trace () {
    return this._tracer.trace.apply(this._tracer, arguments)
  }

  startSpan () {
    return this._tracer.startSpan.apply(this._tracer, arguments)
  }

  inject () {
    return this._tracer.inject.apply(this._tracer, arguments)
  }

  extract () {
    return this._tracer.extract.apply(this._tracer, arguments)
  }

  currentSpan () {
    return this._tracer.currentSpan.apply(this._tracer, arguments)
  }

  bind () {
    return this._tracer.bind.apply(this._tracer, arguments)
  }

  bindEmitter () {
    return this._tracer.bindEmitter.apply(this._tracer, arguments)
  }
}

module.exports = TracerProxy
