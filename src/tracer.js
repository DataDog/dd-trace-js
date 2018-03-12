'use strict'

const platform = require('./platform')
const Tracer = require('./opentracing/tracer')

class DatadogTracer extends Tracer {
  constructor (config) {
    super(config)

    this._context = platform.context(config)
  }

  trace (name, options, callback) {
    if (!callback) {
      callback = options
      options = {}
    }

    this._context.run(() => {
      const childOf = options.childOf || this._context.get('current')
      const tags = Object.assign({
        'service.name': options.service || this._service,
        'resource.name': options.resource || name,
        'span.type': options.type
      }, options.tags)

      const span = this.startSpan(name, { childOf, tags })
      this._context.set('current', span)

      callback(span)
    })
  }

  currentSpan () {
    return this._context.get('current') || null
  }

  bind (callback) {
    return this._context.bind(callback)
  }

  bindEmitter (emitter) {
    this._context.bindEmitter(emitter)
  }
}

module.exports = DatadogTracer
