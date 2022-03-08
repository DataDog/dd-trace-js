'use strict'

const { storage } = require('../../datadog-core')
const Span = require('./opentracing/span')

// TODO: deprecate binding event emitters in 3.0

const originals = new WeakMap()
const listenerMaps = new WeakMap()
const emitterSpans = new WeakMap()
const emitterScopes = new WeakMap()
const emitters = new WeakSet()

class Scope {
  constructor (tracer) {
    this._tracer = tracer
  }

  active () {
    const store = storage.getStore()

    return (store && new Span(this._tracer, store.span)) || null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    span = span && typeof span.context === 'function' && span.context()._span

    const oldStore = storage.getStore()
    const oldSpan = oldStore && oldStore.span

    if (oldStore) {
      oldStore.span = span
    } else {
      storage.enterWith({ span })
    }

    try {
      return callback()
    } catch (e) {
      if (span && typeof span.setTag === 'function') {
        span.setTag('error', e)
      }

      throw e
    } finally {
      if (oldStore) {
        oldStore.span = oldSpan
      } else {
        storage.enterWith(oldStore)
      }
    }
  }

  bind (target, span) {
    target = this._bindEmitter(target, span)
    target = this._bindPromise(target, span)
    target = this._bindFn(target, span)

    return target
  }

  unbind (target) {
    target = this._unbindFn(target)
    target = this._unbindPromise(target)
    target = this._unbindEmitter(target)

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

  _bindEmitter (emitter, span) {
    if (!this._isEmitter(emitter)) return emitter
    if (!emitters.has(emitter)) {
      Scope._wrapEmitter(emitter)
    }
    emitterSpans.set(emitter, span)
    emitterScopes.set(emitter, this)
    return emitter
  }

  // Occasionally we want to wrap a prototype rather than emitter instances,
  // so we're exposing this as a static method. This gives us a faster
  // path for binding instances of known EventEmitter subclasses.
  static _wrapEmitter (emitter) {
    wrapMethod(emitter, 'addListener', wrapAddListener)
    wrapMethod(emitter, 'prependListener', wrapAddListener)
    wrapMethod(emitter, 'on', wrapAddListener)
    wrapMethod(emitter, 'once', wrapAddListener)
    wrapMethod(emitter, 'removeListener', wrapRemoveListener)
    wrapMethod(emitter, 'off', wrapRemoveListener)
    wrapMethod(emitter, 'removeAllListeners', wrapRemoveAllListeners)
    emitters.add(emitter)
  }

  _unbindEmitter (emitter) {
    if (!this._isEmitter(emitter)) return emitter
    emitterScopes.delete(emitter)
    emitterSpans.delete(emitter)
    return emitter
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

  _isEmitter (emitter) {
    return emitter &&
      typeof emitter.emit === 'function' &&
      typeof emitter.on === 'function' &&
      typeof emitter.addListener === 'function' &&
      typeof emitter.removeListener === 'function'
  }

  _isPromise (promise) {
    return promise && typeof promise.then === 'function'
  }
}

function getScope (emitter) {
  return emitterScopes.get(emitter) || emitterScopes.get(emitter.constructor.prototype)
}

function getSpan (emitter) {
  return emitterSpans.get(emitter) || emitterSpans.get(emitter.constructor.prototype)
}

function hasScope (emitter) {
  return emitterScopes.has(emitter) || emitterScopes.has(emitter.constructor.prototype)
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

function wrapAddListener (addListener) {
  return function addListenerWithTrace (eventName, listener) {
    const scope = getScope(this)
    if (!scope || !listener || originals.has(listener) || listener.listener) {
      return addListener.apply(this, arguments)
    }
    const span = getSpan(this)

    const bound = scope.bind(listener, scope._spanOrActive(span))
    const listenerMap = listenerMaps.get(this) || {}

    listenerMaps.set(this, listenerMap)

    if (!listenerMap[eventName]) {
      listenerMap[eventName] = new WeakMap()
    }

    const events = listenerMap[eventName]

    if (!events.has(listener)) {
      events.set(listener, [])
    }

    events.get(listener).push(bound)

    return addListener.call(this, eventName, bound)
  }
}

function wrapRemoveListener (removeListener) {
  return function removeListenerWithTrace (eventName, listener) {
    if (!hasScope(this)) {
      return removeListener.apply(this, arguments)
    }

    const listenerMap = listenerMaps.get(this)
    const listeners = listenerMap && listenerMap[eventName]

    if (!listener || !listeners || !listeners.has(listener)) {
      return removeListener.apply(this, arguments)
    }

    for (const bound of listeners.get(listener)) {
      removeListener.call(this, eventName, bound)
    }

    listeners.delete(listener)

    return removeListener.apply(this, arguments)
  }
}

function wrapRemoveAllListeners (removeAllListeners) {
  return function removeAllListenersWithTrace (eventName) {
    const listenerMap = listenerMaps.get(this)

    if (hasScope(this) && listenerMap) {
      if (eventName) {
        delete listenerMap[eventName]
      } else {
        listenerMaps.delete(this)
      }
    }

    return removeAllListeners.apply(this, arguments)
  }
}

function wrapMethod (target, name, wrapper, ...args) {
  if (!target[name] || originals.has(target[name])) return

  const original = target[name]

  target[name] = wrapper(target[name], ...args)
  originals.set(target[name], original)
}

module.exports = Scope
