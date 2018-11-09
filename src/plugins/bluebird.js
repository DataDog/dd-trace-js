'use strict'

function createWrapThen (tracer, config) {
  return function wrapThen (then) {
    return function thenWithTrace (didFulfill, didReject) {
      arguments[0] = wrapCallback(tracer, didFulfill)
      arguments[1] = wrapCallback(tracer, didReject)

      return then.apply(this, arguments)
    }
  }
}

function wrapCallback (tracer, callback) {
  if (typeof callback !== 'function') return callback

  const scope = tracer.scopeManager().active()

  return function () {
    tracer.scopeManager().activate(scope ? scope.span() : null)
    return callback.apply(this, arguments)
  }
}

module.exports = [
  {
    name: 'bluebird',
    versions: ['2.0.2 - 3'], // 2.0.0 and 2.0.1 were removed from npm
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, '_then', createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, '_then')
    }
  }
]
