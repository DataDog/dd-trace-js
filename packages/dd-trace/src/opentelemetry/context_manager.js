'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { trace, ROOT_CONTEXT } = require('@opentelemetry/api')

const SpanContext = require('./span_context')
const tracer = require('../../')

// Horrible hack to acquire the otherwise inaccessible SPAN_KEY so we can redirect it...
// This is used for getting the current span context in OpenTelemetry, but the SPAN_KEY value is
// not exposed as it's meant to be read-only from outside the module. We want to hijack this logic
// so we can instead get the span context from the datadog context manager instead.
let SPAN_KEY
trace.getSpan({
  getValue (key) {
    SPAN_KEY = key
  }
})

// Whenever a value is acquired from the context map we should mostly delegate to the real getter,
// but when accessing the current span we should hijack that access to instead provide a fake span
// which we can use to get an OTel span context wrapping the datadog active scope span context.
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
      return self.with(context, target, this, ...args)
    }
  }

  // Not part of the spec but the Node.js API expects these
  enable () {}
  disable () {}
}

module.exports = ContextManager
