const shimmer = require('shimmer')
const wrapEmitter = require('emitter-listener')

const SCOPE_SYMBOL = 'dd-trace@scope'

class Scope {
  active () {
    return this._active() || null
  }

  activate (span, callback) {
    if (typeof callback !== 'function') return callback

    return this._activate(span, callback)
  }

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
