'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('datadog:mquery:filter:start')
const finishCh = channel('datadog:mquery:filter:finish')

const methods = ['find', 'findOne', 'findOneAndRemove', 'count', 'distinct', 'where']

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
  // Should string arguments be excluded?
  const arg0 = args[0]
  const filters = arg0 && typeof arg0 === 'object' ? [args[0]] : []

  const arg1 = args[1]
  if (methodsOptionalArgs.includes(methodName) && arg1 && typeof arg1 === 'object') {
    filters.push(arg1)
  }
  return filters
}

addHook({
  name: 'mquery',
  versions: ['>=3.2.3']
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
          startCh.publish({ filters: getFilters(arguments, methodName), setNosqlAnalyzedFlag: false })

          const query = method.apply(this, arguments)

          if (query.then) {
            const origThen = query.then
            query.then = asyncResource.bind(function (resolve, reject) {
              arguments[0] = wrapCallback(asyncResource, resolve)
              arguments[1] = wrapCallback(asyncResource, reject)

              // send start with no filters to set the nosqlAnalyzed flag
              startCh.publish({ setNosqlAnalyzedFlag: true })

              return origThen.apply(this, arguments)
            })
          }

          if (query.exec) {
            const origExec = query.exec
            query.exec = asyncResource.bind(function () {
              try {
                // send start with no filters to set the nosqlAnalyzed flag
                startCh.publish({ setNosqlAnalyzedFlag: true })

                return origExec.apply(this, arguments)
              } finally {
                finishCh.publish()
              }
            })
          }

          return query
        })
      }
    })
  })
  return Query
})
