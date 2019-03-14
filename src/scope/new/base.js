'use strict'

let id = 0

class Scope {
  active () {
    return this._active() || null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    return this._activate(span, callback)
  }

  bind (target, span) {
    if (target === undefined || target === null) return target

    if (this._isEmitter(target)) {
      target = this._bindEmitter(target, span)
    }

    if (this._isPromise(target)) {
      target = this._bindPromise(target, span)
    }

    if (typeof target === 'function') {
      target = this._bindFn(target, span)
    }

    return target
  }

  _active () {
    return null
  }

  _activate (span, callback) {
    return typeof callback === 'function' && callback()
  }

  _bindFn (fn, span) {
    const scope = this
    const spanOrActive = this._spanOrActive(span)

    return function () {
      return scope.activate(spanOrActive, () => {
        return fn.apply(this, arguments)
      })
    }
  }

  _bindEmitter (emitter, span) {
    if (emitter._datadog_events) return emitter

    emitter._datadog_events = {}

    if (emitter.addListener) {
      emitter.addListener = wrapAddListener(emitter.addListener, this, span)
    }

    if (emitter.prependListener) {
      emitter.prependListener = wrapAddListener(emitter.prependListener, this, span)
    }

    if (emitter.on) {
      emitter.on = wrapAddListener(emitter.on, this, span)
    }

    if (emitter.removeListener) {
      emitter.removeListener = wrapRemoveListener(emitter.removeListener)
    }

    if (emitter.off) {
      emitter.off = wrapRemoveListener(emitter.off)
    }

    if (emitter.removeAllListeners) {
      emitter.removeAllListeners = wrapRemoveAllListeners(emitter.removeAllListeners)
    }

    return emitter
  }

  _bindPromise (promise, span) {
    const scope = this
    const then = promise.then

    promise.then = function thenWithTrace (onFulfilled, onRejected) {
      const args = new Array(arguments.length)

      for (let i = 0, l = args.length; i < l; i++) {
        args[i] = scope.bind(arguments[i], span)
      }

      return then.apply(this, args)
    }

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

function wrapAddListener (addListener, scope, span) {
  return function addListenerWithTrace (eventName, listener) {
    if (!listener || listener._datadog_bound) return addListener.apply(this, arguments)

    const bound = scope.bind(listener, scope._spanOrActive(span))

    bound._datadog_bound = true
    listener._datadog_id = listener._datadog_id || ++id

    if (!this._datadog_events[eventName]) {
      this._datadog_events[eventName] = {}
    }

    const events = this._datadog_events[eventName]

    if (!events[id]) {
      events[id] = []
    }

    events[id].push(bound)

    return addListener.call(this, eventName, bound)
  }
}

function wrapRemoveListener (removeListener) {
  return function removeListenerWithTrace (eventName, listener) {
    const listeners = this._datadog_events[eventName]

    if (!listener || !listeners || !listeners[listener._datadog_id]) {
      return removeListener.apply(this, arguments)
    }

    let bound

    while ((bound = listeners[listener._datadog_id].pop())) {
      removeListener.call(this, eventName, bound)
    }

    return removeListener.call(this, eventName, listener)
  }
}

function wrapRemoveAllListeners (removeAllListeners) {
  return function removeAllListenersWithTrace (eventName) {
    if (eventName) {
      this._datadog_events[eventName] = {}
    } else {
      this._datadog_events = {}
    }

    return removeAllListeners.call(this, eventName)
  }
}

module.exports = Scope
