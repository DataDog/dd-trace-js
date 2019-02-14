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

  const span = tracer.scope().active()

  return function () {
    return tracer.scope().activate(span, () => {
      return callback.apply(this, arguments)
    })
  }
}
