'use strict'

require('./mongodb-core')

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

// collection methods with filter
const collectionMethodsWithFilter = [
  'count',
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'find',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
] // findOne is ignored because it calls to find

const collectionMethodsWithTwoFilters = new Set([
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
])

const startCh = channel('datadog:mongodb:collection:filter:start')

addHook({ name: 'mongodb', versions: ['>=3.3 <5', '5', '>=6'] }, mongodb => {
  for (const methodName of [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters]) {
    if (!(methodName in mongodb.Collection.prototype)) continue

    const useTwoArguments = collectionMethodsWithTwoFilters.has(methodName)

    shimmer.wrap(mongodb.Collection.prototype, methodName, method => {
      return function (...args) {
        if (!startCh.hasSubscribers) {
          return method.apply(this, args)
        }

        const ctx = {
          filters: [args[0]],
          methodName,
        }

        if (useTwoArguments) {
          ctx.filters.push(args[1])
        }

        return startCh.runStores(ctx, () => {
          return method.apply(this, args)
        })
      }
    })
  }
  return mongodb
})
