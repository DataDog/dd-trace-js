const shimmer = require('shimmer')
const wrapEmitter = require('emitter-listener')
const asyncHooks = require('../async_hooks')

const SCOPE_SYMBOL = 'dd-trace@scope'

let singleton = null

class Scope {
  constructor () {
    if (singleton) {
      return singleton
    }

    singleton = this

    this._spans = new Map()
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })
  }

  active () {
    return this._spans.get(asyncHooks.executionAsyncId()) || null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    const asyncId = asyncHooks.executionAsyncId()
    const oldSpan = this._spans.get(asyncId)

    if (this._spans.size === 0) {
      this._hook.enable()
    }

    this._spans.set(asyncId, span)

    try {
      return callback() // TODO: add error to span
    } finally {
      if (oldSpan) {
        this._spans.set(asyncId, oldSpan)
      } else {
        this._destroy(asyncId)
      }
    }
  }

  bind (target, span) {
    if (this._isEmitter(target)) {
      return this._bindEmitter(target, span)
    } else if (this._isPromise(target)) {
      return this._bindPromise(target, span)
    } else if (typeof target === 'function') {
      return this._bindFn(target, span)
    } else {
      return null
    }
  }

  _init (asyncId) {
    const span = this._spans.get(asyncHooks.executionAsyncId())

    if (span) {
      this._spans.set(asyncId, span)
    }
  }

  _destroy (asyncId) {
    if (this._spans.delete(asyncId) && !this._spans.size) {
      this._hook.disable()
    }
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
