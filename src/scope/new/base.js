'use strict'

/**
 * The Datadog Scope Manager. This is used for context propagation.
 *
 * @hideconstructor
 */
class Scope {
  /**
   * Get the current active span or null if there is none.
   *
   * @returns {Span} The active span.
   */
  active () {
    return this._active() || null
  }

  /**
   * Activate a span in the scope of a function.
   *
   * @param {external:"opentracing.Span"} span The span to activate.
   * @param {Function} [callback] Function that will have the span activated on its scope.
   * @returns The return value of the callback.
   */
  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    return this._activate(span, callback)
  }

  /**
   * Binds a target to the provided span, or the active span if omitted.
   *
   * @param {Function|Promise|EventEmitter} target Function that will have the span activated on its scope.
   * @param {?(external:"opentracing.Span")} [span=scope.active()] The span to activate.
   * @returns The bound target.
   */
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
    return null
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
      return then.apply(this, Array.prototype.map.call(arguments, arg => {
        if (typeof arg !== 'function') { return arg }
        return scope.bind(arg, span)
      }))
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

    if (!this._datadog_events[eventName]) {
      this._datadog_events[eventName] = new Map()
    }

    if (!this._datadog_events[eventName][listener]) {
      this._datadog_events[eventName][listener] = []
    }

    this._datadog_events[eventName][listener].push(bound)

    return addListener.call(this, eventName, bound)
  }
}

function wrapRemoveListener (removeListener) {
  return function removeListenerWithTrace (eventName, listener) {
    const listeners = this._datadog_events[eventName]

    if (!listener || !listeners || !listeners[listener]) {
      return removeListener.apply(this, arguments)
    }

    let bound

    while ((bound = listeners.pop())) {
      this.removeListener(eventName, bound)
    }

    return removeListener.call(this, eventName, listener)
  }
}

function wrapRemoveAllListeners (removeAllListeners) {
  return function removeAllListenersWithTrace (eventName) {
    if (eventName) {
      this._datadog_events[eventName] = new Map()
    } else {
      this._datadog_events = {}
    }

    return removeAllListeners.call(this, eventName)
  }
}

module.exports = Scope
