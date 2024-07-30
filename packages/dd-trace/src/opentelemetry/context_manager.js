'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { trace, ROOT_CONTEXT } = require('@opentelemetry/api')
const DataDogSpanContext = require('../opentracing/span_context')

const SpanContext = require('./span_context')
const tracer = require('../../')

class ContextManager {
  constructor () {
    this._store = new AsyncLocalStorage()
  }

  active () {
    const activeSpan = tracer.scope().active()

    const context = (activeSpan && activeSpan.context()) || this._store.getStore() || ROOT_CONTEXT
    if (context instanceof DataDogSpanContext) {
      const newSpanContext = new SpanContext(context)
      return trace.setSpanContext(ROOT_CONTEXT, newSpanContext)
    }
    return context
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
