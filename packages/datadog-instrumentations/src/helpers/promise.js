'use strict'

const { AsyncResource } = require('async_hooks')

exports.wrapThen = function wrapThen (origThen) {
  return function then (onFulfilled, onRejected, onProgress) {
    const ar = new AsyncResource('bound-anonymous-fn')

    arguments[0] = wrapCallback(ar, onFulfilled)
    arguments[1] = wrapCallback(ar, onRejected)

    // not standard but sometimes supported
    if (onProgress) {
      arguments[2] = wrapCallback(ar, onProgress)
    }

    return origThen.apply(this, arguments)
  }
}

function wrapCallback (ar, callback) {
  if (typeof callback !== 'function') return callback

  return function () {
    return ar.runInAsyncScope(() => {
      return callback.apply(this, arguments)
    })
  }
}
