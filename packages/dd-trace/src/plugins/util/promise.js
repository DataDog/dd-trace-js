'use strict'

const {
  bind
} = require('../../../../datadog-instrumentations/src/helpers/instrument')

module.exports = {
  createWrapThen () {
    return function wrapThen (then) {
      return function thenWithTrace (onFulfilled, onRejected, onProgress) {
        arguments[0] = wrapCallback(onFulfilled)
        arguments[1] = wrapCallback(onRejected)

        // not standard but sometimes supported
        if (onProgress) {
          arguments[2] = wrapCallback(onProgress)
        }

        return then.apply(this, arguments)
      }
    }
  }
}

function wrapCallback (callback) {
  return typeof callback === 'function' ? bind(callback) : callback
}
