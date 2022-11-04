'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { trace, ROOT_CONTEXT } = require('@opentelemetry/api')

const SpanContext = require('./span_context')
const tracer = require('../../')

// Horrible hack to acquire the otherwise inaccessible SPAN_KEY so we can redirect it...
let SPAN_KEY
trace.getSpan({
  getValue (key) {
    SPAN_KEY = key
  }
})

function wrappedGetValue (target) {
  return (key) => {
    if (key === SPAN_KEY) {
      return {
        spanContext () {
          const activeSpan = tracer.scope().active()
          const context = activeSpan && activeSpan.context()
          return new SpanContext(context)
        }
      }
    }
    return target.getValue(key)
  }
}

class ContextManager {
  constructor () {
    this._store = new AsyncLocalStorage()
  }

  active () {
    const active = this._store.getStore() || ROOT_CONTEXT

    return new Proxy(active, {
      get (target, key) {
        return key === 'getValue' ? wrappedGetValue(target) : target[key]
      }
    })
  }

  with (context, fn, thisArg, ...args) {
    const span = trace.getSpan(context)
    const ddScope = tracer.scope()
    return ddScope.activate(span._ddSpan, () => {
      const cb = thisArg == null ? fn : fn.bind(thisArg)
      return this._store.run(context, cb, ...args)
    })
  }

  bind (context, target) {
    const self = this
    return function (...args) {
      return self.with(context, target, this, args)
    }
  }

  enable () {}
  disable () {}
}

module.exports = ContextManager
