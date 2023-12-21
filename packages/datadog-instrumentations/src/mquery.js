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

// function wrapCallback (asyncResource, callback) {
//   return asyncResource.bind(function () {
//     finishCh.publish()

//     if (callback) {
//       return callback.apply(this, arguments)
//     }
//   })
// }

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

          return method.apply(this, arguments)
        })
      }
    })
  })

  shimmer.wrap(Query.prototype, 'exec', originalExec => {
    return function wrappedExec () {
      if (!startCh.hasSubscribers) {
        return originalExec.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        startCh.publish()

        const promise = originalExec.apply(this, arguments)

        if (!promise.then) {
          finish(finishCh)
        } else {
          promise.then(asyncResource.bind(() => finish(finishCh)),
            asyncResource.bind(() => finish(finishCh)))
        }

        return promise
      })
    }
  })

  return Query
})

function finish (finishCh) {
  finishCh.publish()
}
