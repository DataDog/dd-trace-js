'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('datadog:mquery:filter:start')
const finishCh = channel('datadog:mquery:filter:finish')

const methods = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndRemove', 'count', 'distinct']

function wrapCallback (asyncResource, callback, filters) {
  if (typeof callback !== 'function') return callback

  return function () {
    return asyncResource.runInAsyncScope(() => {
      try {
        return callback.apply(this, arguments)
      } finally {
        finishCh.publish({ filters })
      }
    })
  }
}

addHook({
  name: 'mquery',
  versions: ['>=4.0.0']
}, Query => {
  methods.forEach(methodName => {
    if (!(methodName in Query.prototype)) return

    shimmer.wrap(Query.prototype, methodName, method => {
      return function () {
        if (!startCh.hasSubscribers) {
          return method.apply(this, arguments)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        return asyncResource.runInAsyncScope(() => {
          const filters = arguments.length > 0 ? [arguments[0]] : []

          startCh.publish({
            filters,
            methodName
          })

          const query = method.apply(this, arguments)

          if (query.then) {
            const origThen = query.then
            query.then = asyncResource.bind(function (onFulfilled, onRejected) {
              arguments[0] = wrapCallback(asyncResource, onFulfilled, filters)
              arguments[1] = wrapCallback(asyncResource, onRejected, filters)

              return origThen.apply(this, arguments)
            })
          }

          return query
        })
      }
    })
  })
  return Query
})
