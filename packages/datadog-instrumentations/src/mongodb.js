'use strict'

require('./mongodb-core')
const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// collection methods with filter
const collectionMethodsWithFilter = [
  'count',
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'find',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne'
] // findOne is ignored because it calls to find
const collectionMethodsWithTwoFilters = [
  'findOneAndUpdate',
  'updateMany',
  'updateOne'
]

const startCh = channel('datadog:mongodb:collection:filter:start')

addHook({ name: 'mongodb', versions: ['>=3.3'] }, mongodb => {
  [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters].forEach(methodName => {
    try {
      const useTwoArguments = collectionMethodsWithTwoFilters.includes(methodName)

      shimmer.wrap(mongodb.Collection.prototype, methodName, method => {
        return function () {
          if (!startCh.hasSubscribers) {
            return method.apply(this, arguments)
          }

          const asyncResource = new AsyncResource('bound-anonymous-fn')

          return asyncResource.runInAsyncScope(() => {
            const filters = [arguments[0]]
            if (useTwoArguments) {
              filters.push(arguments[1])
            }

            startCh.publish({
              filters,
              methodName
            })

            return method.apply(this, arguments)
          })
        }
      })
    } catch (e) {
      // do nothing if the method wrap fail
    }
  })
  return mongodb
})
