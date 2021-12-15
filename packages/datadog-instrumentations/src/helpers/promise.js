'use strict'

const {
  bind
} = require('./instrument')

exports.wrapThen = function wrapThen (then) {
  return function then (onFulfilled, onRejected, onProgress) {
    arguments[0] = wrapCallback(onFulfilled)
    arguments[1] = wrapCallback(onRejected)

    // not standard but sometimes supported
    if (onProgress) {
      arguments[2] = wrapCallback(onProgress)
    }

    return then.apply(this, arguments)
  }
}

function wrapCallback (callback) {
  return typeof callback === 'function' ? bind(callback) : callback
}
