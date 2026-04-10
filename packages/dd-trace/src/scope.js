'use strict'

const { storage } = require('../../datadog-core')
const PublicSpan = require('./opentracing/public/span')

// TODO: refactor bind to use shimmer once the new internal tracer lands

const originals = new WeakMap()

class Scope {
  active () {
    const store = storage('legacy').getStore()
    const span = (store && store.span) || null

    return span ? new PublicSpan(span) : null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    // We need the span fallback because Otel (e.g. the OTel context manager)
    // passes raw DDSpans that which have no ._span property.
    span = span?._span || span

    const oldStore = storage('legacy').getStore()
    const newStore = span ? storage('legacy').getStore(span._store) : oldStore

    storage('legacy').enterWith({ ...newStore, span })

    try {
      return callback()
    } catch (e) {
      if (span && typeof span.setTag === 'function') {
        span.setTag('error', e)
      }

      throw e
    } finally {
      storage('legacy').enterWith(oldStore)
    }
  }

  bind (fn, span) {
    if (typeof fn !== 'function') return fn

    // We need the span fallback because Otel (e.g. the OTel context manager)
    // passes raw DDSpans that which have no ._span property.
    span = span?._span || span

    const scope = this
    const spanOrActive = this._spanOrActive(span)

    const bound = function () {
      return scope.activate(spanOrActive, () => {
        return fn.apply(this, arguments)
      })
    }

    originals.set(bound, fn)

    return bound
  }

  _spanOrActive (span) {
    return span === undefined ? this.active() : span
  }

  _isPromise (promise) {
    return promise && typeof promise.then === 'function'
  }
}

module.exports = Scope
