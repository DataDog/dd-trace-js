'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('datadog:mquery:filter:start')
const finishCh = channel('datadog:mquery:filter:finish')

const methods = ['find', 'findOne', 'findOneAndRemove', 'count', 'distinct']

const methodsOptionalArgs = ['findOneAndUpdate']

function wrapCallback (asyncResource, callback) {
  if (typeof callback !== 'function') return callback

  return function () {
    return asyncResource.runInAsyncScope(() => {
      try {
        return callback.apply(this, arguments)
      } finally {
        finishCh.publish()
      }
    })
  }
}

function getFilters (args, methodName) {
  const filters = [args[0]]

  if (methodsOptionalArgs.includes(methodName)) {
    filters.push(args[1])
  }
  return filters
}

addHook({
  name: 'mquery',
  versions: ['>=4.0.0']
}, Query => {
  [...methods, ...methodsOptionalArgs].forEach(methodName => {
    if (!(methodName in Query.prototype)) return

    shimmer.wrap(Query.prototype, methodName, method => {
      return function () {
        if (!startCh.hasSubscribers) {
          return method.apply(this, arguments)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        return asyncResource.runInAsyncScope(() => {
          startCh.publish({
            filters: getFilters(arguments, methodName),
            methodName
          })

          const query = method.apply(this, arguments)

          if (query.then) {
            const origThen = query.then
            query.then = asyncResource.bind(function (onResolved, onRejected) {
              arguments[0] = wrapCallback(asyncResource, onResolved)
              arguments[1] = wrapCallback(asyncResource, onRejected)

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
