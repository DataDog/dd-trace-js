'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('datadog:mongodb:collection:filter:start')

addHook({
  name: 'mquery',
  versions: ['>=4.0.0']
}, Query => {
  shimmer.wrap(Query.prototype, 'then', method => {
    return function () {
      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        return method.apply(this, arguments)
      })
    }
  })

  shimmer.wrap(Query.prototype, 'find', method => {
    return function () {
      if (!startCh.hasSubscribers) {
        return method.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        const filters = [arguments[0]]

        startCh.publish({
          filters,
          methodName: 'find'
        })

        return method.apply(this, arguments)
      })
    }
  })
  return Query
})
