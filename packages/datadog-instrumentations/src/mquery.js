'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const prepareCh = channel('datadog:mquery:filter:prepare')
const startCh = channel('datadog:mquery:filter:start')
const finishCh = channel('datadog:mquery:filter:finish')

const methods = ['find', 'findOne', 'findOneAndRemove', 'findOneAndDelete', 'count', 'distinct', 'where']

const methodsOptionalArgs = ['findOneAndUpdate']

function wrapCallback (asyncResource, callback) {
  return asyncResource.bind(function () {
    finishCh.publish()

    if (callback) {
      return callback.apply(this, arguments)
    }
  })
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
      return function wrappedMqueryMethod () {
        if (!startCh.hasSubscribers) {
          return method.apply(this, arguments)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        return asyncResource.runInAsyncScope(() => {
          prepareCh.publish({ filters: getFilters(arguments, methodName) })

          const query = method.apply(this, arguments)

          if (query.then) {
            const origThen = query.then
            query.then = asyncResource.bind(function wrappedThen (resolve, reject) {
              arguments[0] = wrapCallback(asyncResource, resolve)
              arguments[1] = wrapCallback(asyncResource, reject)

              // send start with no filters to set the nosqlAnalyzed flag
              startCh.publish()

              return origThen.apply(this, arguments)
            })
          }

          if (query.exec) {
            const origExec = query.exec
            query.exec = asyncResource.bind(function wrappedExec () {
              try {
                // send start with no filters to set the nosqlAnalyzed flag
                startCh.publish()

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
