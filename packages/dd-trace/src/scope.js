'use strict'

const { storage } = require('../../datadog-core')

// TODO: refactor bind to use shimmer once the new internal tracer lands

const originals = new WeakMap()

class Scope {
  active () {
    const store = storage.getStore()

    return (store && store.span) || null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    const oldStore = storage.getStore()
    const newStore = span ? span._store : oldStore

    storage.enterWith({ ...newStore, span })

    try {
      return callback()
    } catch (e) {
      if (span && typeof span.setTag === 'function') {
        span.setTag('error', e)
      }

      throw e
    } finally {
      storage.enterWith(oldStore)
    }
  }

  bind (target, span) {
    target = this._bindPromise(target, span)
    target = this._bindFn(target, span)

    return target
  }

  unbind (target) {
    target = this._unbindFn(target)
    target = this._unbindPromise(target)

    return target
  }

  _bindFn (fn, span) {
    if (typeof fn !== 'function') return fn

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

  _unbindFn (fn) {
    if (typeof fn !== 'function') return fn

    return originals.get(fn) || fn
  }

  _bindPromise (promise, span) {
    if (!this._isPromise(promise)) return promise

    wrapMethod(promise, 'then', wrapThen, this, span)

    return promise
  }

  _unbindPromise (promise) {
    if (!this._isPromise(promise)) return promise

    promise.then = originals.get(promise.then) || promise.then

    return promise
  }

  _spanOrActive (span) {
    return span !== undefined ? span : this.active()
  }

  _isPromise (promise) {
    return promise && typeof promise.then === 'function'
  }
}

function wrapThen (then, scope, span) {
  return function thenWithTrace (onFulfilled, onRejected) {
    const args = new Array(arguments.length)

    for (let i = 0, l = args.length; i < l; i++) {
      args[i] = scope.bind(arguments[i], span)
    }

    return then.apply(this, args)
  }
}

function wrapMethod (target, name, wrapper, ...args) {
  if (!target[name] || originals.has(target[name])) return

  const original = target[name]

  target[name] = wrapper(target[name], ...args)
  originals.set(target[name], original)
}

module.exports = Scope
