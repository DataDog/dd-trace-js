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

addHook({ name: '@elastic/transport', file: 'lib/Transport.js', versions: ['>=8'] }, (exports) => {
  shimmer.wrap(exports.default.prototype, 'request', wrapRequest)
  return exports
})

addHook({ name: '@elastic/elasticsearch', file: 'lib/Transport.js', versions: ['>=5.6.16 <8', '>=8'] }, Transport => {
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

    const parentResource = new AsyncResource('bound-anonymous-fn')

    startCh.publish({ params })

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    try {
      const lastIndex = arguments.length - 1
      cb = arguments[lastIndex]

      if (typeof cb === 'function') {
        cb = parentResource.bind(cb)

        arguments[lastIndex] = asyncResource.bind(function (error) {
          finish(params, error)
          return cb.apply(null, arguments)
        })
        return request.apply(this, arguments)
      } else {
        const promise = request.apply(this, arguments)
        if (promise && typeof promise.then === 'function') {
          const onResolve = asyncResource.bind(() => finish(params))
          const onReject = asyncResource.bind(e => finish(params, e))

          promise.then(onResolve, onReject)
        } else {
          finish(params)
        }
        return promise
      }
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  }
}

function finish (params, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish({ params })
}
