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

const collectionMethodsWithTwoFilters = [
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
]

const startCh = channel('datadog:mongodb:collection:filter:start')

const bulkWriteStartCh = channel('apm:mongodb:bulkwrite:start')
const bulkWriteFinishCh = channel('apm:mongodb:bulkwrite:finish')
const bulkWriteErrorCh = channel('apm:mongodb:bulkwrite:error')

addHook({ name: 'mongodb', versions: ['>=3.3 <5', '5', '>=6'] }, mongodb => {
  for (const methodName of [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters]) {
    if (!(methodName in mongodb.Collection.prototype)) continue

    const useTwoArguments = collectionMethodsWithTwoFilters.includes(methodName)

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

  // `bulkWrite` fans out into separate `insert`/`update`/`delete` wire commands, so wrap
  // it to open one parent span those per-type commands nest under as children.
  if ('bulkWrite' in mongodb.Collection.prototype) {
    shimmer.wrap(mongodb.Collection.prototype, 'bulkWrite', wrapBulkWrite)
  }

  return mongodb
})

/**
 * @param {Function} bulkWrite
 * @returns {Function}
 */
function wrapBulkWrite (bulkWrite) {
  return function (...args) {
    /* istanbul ignore if: plugin stays subscribed for the whole suite; the disabled fast path is unreachable */
    if (!bulkWriteStartCh.hasSubscribers) {
      return bulkWrite.apply(this, args)
    }

    const ctx = { ns: this.namespace }

    return bulkWriteStartCh.runStores(ctx, () => {
      // Pre-v5 drivers take a trailing callback and return `undefined`; v5+ ignore any
      // extra argument and always return a promise. Wrap a trailing callback for the
      // legacy path and finish on the returned promise when there is one, so both APIs are
      // covered without sniffing the version. Pre-v5 also validates arguments synchronously,
      // so guard the call to finish the span instead of leaking it on a throw.
      const lastIndex = args.length - 1
      const callback = args[lastIndex]
      if (typeof callback === 'function') {
        args[lastIndex] = shimmer.wrapCallback(callback, callback => function (error) {
          if (error) {
            ctx.error = error
            bulkWriteErrorCh.publish(ctx)
          }
          return bulkWriteFinishCh.runStores(ctx, callback, this, ...arguments)
        })
      }

      let result
      try {
        result = bulkWrite.apply(this, args)
      } catch (error) {
        finishBulkWriteError(ctx, error)
        throw error
      }

      if (result !== undefined && typeof result.then === 'function') {
        result.then(function (value) {
          ctx.result = value
          bulkWriteFinishCh.publish(ctx)
        }, function (error) {
          finishBulkWriteError(ctx, error)
        })
      }

      return result
    })
  }
}

/**
 * @param {{ error?: unknown }} ctx
 * @param {unknown} error
 */
function finishBulkWriteError (ctx, error) {
  ctx.error = error
  bulkWriteErrorCh.publish(ctx)
  bulkWriteFinishCh.publish(ctx)
}
