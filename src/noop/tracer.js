'use strict'

const Tracer = require('opentracing').Tracer
const Span = require('./span')

const span = new Span()

class NoopTracer extends Tracer {
  constructor (config) {
    super(config)

    let ScopeManager
    let Scope

    if (process.env.DD_CONTEXT_PROPAGATION === 'false') {
      ScopeManager = require('../scope/noop/scope_manager')
      Scope = require('../scope/new/base')
    } else {
      ScopeManager = require('../scope/scope_manager')
      Scope = require('../scope/new/scope')
    }

    this._scopeManager = new ScopeManager()
    this._scope = new Scope()
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

  _startSpan (name, options) {
    return span
  }
}

module.exports = NoopTracer
