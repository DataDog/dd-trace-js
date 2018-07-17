'use strict'

const Tracer = require('opentracing').Tracer
const ScopeManager = require('./scope/scope_manager')

class NoopTracer extends Tracer {
  constructor (config) {
    super(config)

    this._scopeManager = new ScopeManager()
  }

  trace (operationName, options, callback) {
    callback(this.startSpan())
  }

  scopeManager () {
    return this._scopeManager
  }

  currentSpan () {
    return null
  }
}

module.exports = NoopTracer
