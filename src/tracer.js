'use strict'

const Tracer = require('./opentracing/tracer')

class DatadogTracer extends Tracer {
  constructor (config) {
    super(config)

    let ScopeManager
    let Scope

    if (process.env.DD_CONTEXT_PROPAGATION === 'false') {
      ScopeManager = require('./scope/noop/scope_manager')
    } else {
      ScopeManager = require('./scope/scope_manager')
      Scope = require('./scope/new/scope')
    }

    this._scopeManager = new ScopeManager()
    this._scope = new Scope()
  }

  trace (name, options, callback) {
    if (!callback) {
      callback = options
      options = {}
    }

    const childOf = options.childOf !== undefined ? options.childOf : this.currentSpan()
    const defaultTags = {
      'service.name': options.service || this._service,
      'resource.name': options.resource || name
    }

    if (options.type) {
      defaultTags['span.type'] = options.type
    }

    const tags = Object.assign(defaultTags, options.tags)
    const span = this.startSpan(name, { childOf, tags })

    setImmediate(() => {
      this._scopeManager.activate(span, true)
      callback(span)
    })
  }

  scopeManager () {
    return this._scopeManager
  }

  scope () {
    return this._scope
  }

  currentSpan () {
    const scope = this._scopeManager.active()
    return scope ? scope.span() : null
  }
}

module.exports = DatadogTracer
