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

const methods = [
  'find',
  'findOne',
  'findOneAndRemove',
  'findOneAndDelete',
  'count',
  'distinct',
  'where'
]

const methodsOptionalArgs = ['findOneAndUpdate']

function getFilters (args, methodName) {
  const arg0 = args[0]
  const filters = arg0 && typeof arg0 === 'object' ? [args[0]] : []

  const arg1 = args[1]
  if (arg1 && typeof arg1 === 'object' && methodsOptionalArgs.includes(methodName)) {
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
        if (prepareCh.hasSubscribers) {
          const filters = getFilters(arguments, methodName)
          if (filters?.length) {
            prepareCh.publish({ filters })
          }
        }

        return method.apply(this, arguments)
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

        if (!promise || typeof promise.then !== 'function') {
          finish(finishCh)
          return promise
        }

        return promise.then(asyncResource.bind(() => finish(finishCh)),
          asyncResource.bind(() => finish(finishCh)))
      })
    }
  })

  return Query
})

function finish (finishCh) {
  finishCh.publish()
}
