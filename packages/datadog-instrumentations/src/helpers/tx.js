'use strict'

const tx = {
  // Wrap a promise or a callback to also finish the span.
  wrap (asyncEndCh, errorCh, done) {
    if (typeof done === 'function' || !done) {
      return wrapCallback(asyncEndCh, errorCh, done)
    } else if (isPromise(done)) {
      return wrapPromise(asyncEndCh, errorCh, done)
    } else if (done && done.length) {
      return wrapArguments(asyncEndCh, errorCh, done)
    }
  }
}

function wrapCallback (asyncEndCh, errorCh, callback) {
  return function (err) {
    finish(asyncEndCh, errorCh, err)
    if (callback) {
      return callback.apply(this, arguments)
    }
  }
}

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}

function isPromise (obj) {
  return isObject(obj) && typeof obj.then === 'function'
}

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}

function wrapPromise (asyncEndCh, errorCh, promise) {
  promise.then(
    () => finish(asyncEndCh, errorCh),
    err => finish(asyncEndCh, errorCh, err)
  )
  return promise
}

function wrapArguments (asyncEndCh, errorCh, args) {
  const lastIndex = args.length - 1
  const callback = args[lastIndex]

  if (typeof callback === 'function') {
    args[lastIndex] = wrapCallback(asyncEndCh, errorCh, args[lastIndex])
  }

  return args
}

module.exports = tx
