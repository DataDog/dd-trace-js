'use strict'

const { kStoreRetirement, storage } = require('../../datadog-core/src/storage')

const legacyStorage = storage('legacy')

// TODO: refactor bind to use shimmer once the new internal tracer lands
class Scope {
  active () {
    const store = legacyStorage.getStore()

    return store?.span ?? null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

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

    if (span === undefined) {
      const store = legacyStorage.getStore()
      if (store?.[kStoreRetirement]) {
        return function (...args) {
          try {
            return legacyStorage.run(store, () => fn.apply(this, args))
          } catch (error) {
            store.span?.setTag('error', error)
            throw error
          }
        }
      }
      span = this.active()
    }

    const scope = this

    return function (...args) {
      return scope.activate(span, () => {
        return fn.apply(this, args)
      })
    }
  }
}

module.exports = Scope
