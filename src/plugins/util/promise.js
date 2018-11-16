'use strict'

module.exports = {
  createWrapThen (tracer, config) {
    return function wrapThen (then) {
      return function thenWithTrace (onFulfilled, onRejected, onProgress) {
        arguments[0] = wrapCallback(tracer, onFulfilled)
        arguments[1] = wrapCallback(tracer, onRejected)

        // not standard but sometimes supported
        if (onProgress) {
          arguments[2] = wrapCallback(tracer, onProgress)
        }

        return then.apply(this, arguments)
      }
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
