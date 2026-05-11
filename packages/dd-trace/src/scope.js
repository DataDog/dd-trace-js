'use strict'

const { storage } = require('../../datadog-core')
const { PublicSpan, unwrap } = require('./opentracing/public/span')

const legacyStorage = storage('legacy')

// TODO: refactor bind to use shimmer once the new internal tracer lands
class Scope {
  active () {
    const store = legacyStorage.getStore()
    const span = (store && store.span) || null

    return span ? new PublicSpan(span) : null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    span = unwrap(span)

    const oldStore = legacyStorage.getStore()
    const newStore = span ? legacyStorage.getStore(span._store) : oldStore

    legacyStorage.enterWith({ ...newStore, span })

    try {
      return callback()
    } catch (e) {
      if (span && typeof span.setTag === 'function') {
        span.setTag('error', e)
      }

      throw e
    } finally {
      legacyStorage.enterWith(oldStore)
    }
  }

  bind (fn, span) {
    if (typeof fn !== 'function') return fn

    const scope = this
    const spanOrActive = this._spanOrActive(span)

    return function (...args) {
      return scope.activate(spanOrActive, () => {
        return fn.apply(this, args)
      })
    }
  }

  _spanOrActive (span) {
    return span === undefined ? this.active() : span
  }

  _isPromise (promise) {
    return promise && typeof promise.then === 'function'
  }
}

module.exports = Scope
