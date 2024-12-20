'use strict'

const { storage } = require('../../../datadog-core')
const { trace, ROOT_CONTEXT } = require('@opentelemetry/api')
const DataDogSpanContext = require('../opentracing/span_context')

const SpanContext = require('./span_context')
const tracer = require('../../')

class ContextManager {
  constructor () {
    this._store = storage('opentelemetry')
  }

  active () {
    const activeSpan = tracer.scope().active()
    const store = this._store.getStore()
    const context = (activeSpan && activeSpan.context()) || store || ROOT_CONTEXT

    if (!(context instanceof DataDogSpanContext)) {
      return context
    }

    if (!context._otelSpanContext) {
      const newSpanContext = new SpanContext(context)
      context._otelSpanContext = newSpanContext
    }
    if (store && trace.getSpanContext(store) === context._otelSpanContext) {
      return store
    }
    return trace.setSpanContext(store || ROOT_CONTEXT, context._otelSpanContext)
  }

  with (context, fn, thisArg, ...args) {
    const span = trace.getSpan(context)
    const ddScope = tracer.scope()
    const run = () => {
      const cb = thisArg == null ? fn : fn.bind(thisArg)
      return this._store.run(context, cb, ...args)
    }
    if (span && span._ddSpan) {
      return ddScope.activate(span._ddSpan, run)
    }
    return run()
  }

  bind (context, target) {
    const self = this
    return function (...args) {
      return self.with(context, target, this, ...args)
    }
  }

  enable () {}
  disable () {}
}
module.exports = ContextManager
