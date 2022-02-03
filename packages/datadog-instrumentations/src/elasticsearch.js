'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:elasticsearch:query:start')
const asyncEndCh = channel('apm:elasticsearch:query:async-end')
const endCh = channel('apm:elasticsearch:query:end')
const errorCh = channel('apm:elasticsearch:query:error')

addHook({ name: '@elastic/elasticsearch', file: 'lib/Transport.js', versions: ['>=5.6.16'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', wrapRequest)
  return Transport
})

addHook({ name: 'elasticsearch', file: 'src/lib/transport.js', versions: ['>=10'] }, Transport => {
  shimmer.wrap(Transport.prototype, 'request', wrapRequest)
  return Transport
})

function wrapRequest (request) {
  return function (params, options, cb) {
    if (!startCh.hasSubscribers) {
      return request.apply(this, arguments)
    }

    if (!params) return request.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    startCh.publish([params])
    const lastIndex = arguments.length - 1
    cb = arguments[lastIndex]

    if (typeof cb === 'function') {
      cb = asyncResource.bind(cb)

      arguments[lastIndex] = AsyncResource.bind(function (error) {
        finish(params, error)
        return cb.apply(null, arguments)
      })

      return wrapReturn(asyncResource.runInAsyncScope(() => {
        return request.apply(this, arguments)
      }))
    } else {
      const promise = request.apply(this, arguments)
      if (promise && typeof promise.then === 'function') {
        promise.then(() => finish(params), e => finish(params, e))
      } else {
        finish(params)
      }
      return promise
    }
  }
}

function finish (params, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish([params])
}

function wrapReturn (fn) {
  try {
    return fn
  } catch (err) {
    err.stack // trigger getting the stack at the original throwing point
    errorCh.publish(err)

    throw err
  } finally {
    endCh.publish(undefined)
  }
}
