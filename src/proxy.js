'use strict'

const Tracer = require('opentracing').Tracer
const NoopTracer = require('./noop')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const Instrumenter = require('./instrumenter')
const platform = require('./platform')

const noop = new NoopTracer()

class TracerProxy extends Tracer {
  constructor () {
    super()
    this._tracer = noop
    this._instrumenter = new Instrumenter(this)
  }

  init (options) {
    if (this._tracer === noop) {
      platform.load()

      const config = new Config(options)

      this._instrumenter.patch(config)
      this._tracer = new DatadogTracer(config)
    }

    return this
  }

  use () {
    this._instrumenter.use.apply(this._instrumenter, arguments)
    return this
  }

  trace (operationName, options, callback) {
    if (callback) {
      return this._tracer.trace(operationName, options, callback)
    } else if (options instanceof Function) {
      return this._tracer.trace(operationName, options)
    } else if (options) {
      return new Promise((resolve, reject) => {
        this._tracer.trace(operationName, options, span => resolve(span))
      })
    } else {
      return new Promise((resolve, reject) => {
        this._tracer.trace(operationName, span => resolve(span))
      })
    }
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
