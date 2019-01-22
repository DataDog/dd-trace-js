'use strict'

const shimmer = require('shimmer')
const wrapEmitter = require('emitter-listener')

const SCOPE_SYMBOL = 'dd-trace@scope'

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
    if (this._isEmitter(target)) {
      return this._bindEmitter(target, span)
    } else if (this._isPromise(target)) {
      return this._bindPromise(target, span)
    } else if (typeof target === 'function') {
      return this._bindFn(target, span)
    } else {
      return target
    }
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
    const scope = this

    function mark (listener) {
      if (!listener) { return }

      listener[SCOPE_SYMBOL] = listener[SCOPE_SYMBOL] || []
      listener[SCOPE_SYMBOL].push(scope._spanOrActive(span))
    }

    function prepare (listener) {
      if (!listener || !listener[SCOPE_SYMBOL]) { return listener }

      return listener[SCOPE_SYMBOL]
        .reduce((prev, next) => {
          return scope.bind(prev, next)
        }, listener)
    }

    wrapEmitter(emitter, mark, prepare)

    return emitter
  }

  _bindPromise (promise, span) {
    const scope = this

    shimmer.wrap(promise, 'then', (then) => {
      return function () {
        return then.apply(this, Array.prototype.map.call(arguments, arg => {
          if (typeof arg !== 'function') { return arg }
          return scope.bind(arg, span)
        }))
      }
    })

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

module.exports = Scope
