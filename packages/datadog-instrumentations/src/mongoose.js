'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

const startCh = channel('datadog:mongoose:model:filter:start')
const finishCh = channel('datadog:mongoose:model:filter:finish')
// Bound around the deferred query execution. A subscriber returns the store that
// stays active for the whole async scope that reaches the mongodb driver, so the
// nested driver query can see the parent's analysis marker without it leaking
// past the query. `runStores` enters the store only for that scope and restores
// the parent on its own.
const execCh = channel('datadog:mongoose:model:filter:exec')
// this channel is for wrapping the callback of exec methods and handling store context
const execStartCh = channel('apm:mongoose:exec:start')
const execFinishCh = channel('apm:mongoose:exec:finish')

function wrapAddQueue (addQueue) {
  const ctx = {}

  return execStartCh.runStores(ctx, () => {
    return function addQueueWithTrace (name) {
      return execFinishCh.runStores(ctx, () => {
        return addQueue.apply(this, arguments)
      })
    }
  })
}

addHook({
  name: 'mongoose',
  versions: ['>=4.6.4 <5', '5', '6', '>=7'],
  file: 'lib/index.js',
}, mongoose => {
  // As of Mongoose 7, custom promise libraries are no longer supported and mongoose.Promise may be undefined
  if (mongoose.Promise && mongoose.Promise !== global.Promise) {
    shimmer.wrap(mongoose.Promise.prototype, 'then', wrapThen)
  }

  shimmer.wrap(mongoose.Collection.prototype, 'addQueue', wrapAddQueue)

  return mongoose
})

const collectionMethodsWithFilter = [
  'count',
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'remove',
]

const collectionMethodsWithTwoFilters = [
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
]

addHook({
  name: 'mongoose',
  versions: ['>=4.6.4 <5', '5', '6', '>=7'],
  file: 'lib/model.js',
}, Model => {
  for (const methodName of [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters]) {
    const useTwoArguments = collectionMethodsWithTwoFilters.includes(methodName)
    if (!(methodName in Model)) continue

    shimmer.wrap(Model, methodName, method => {
      return function wrappedModelMethod (...args) {
        if (!startCh.hasSubscribers) {
          return method.apply(this, args)
        }

        const filters = [args[0]]
        if (useTwoArguments) {
          filters.push(args[1])
        }

        let callbackWrapped = false

        const wrapCallbackIfExist = (args, ctx) => {
          const lastArgumentIndex = args.length - 1

          if (typeof args[lastArgumentIndex] === 'function') {
            // is a callback, wrap it to execute finish()
            shimmer.wrap(args, lastArgumentIndex, originalCb => {
              return function (...args) {
                finishCh.publish(ctx)

                return originalCb.apply(this, args)
              }
            })

            callbackWrapped = true
          }
        }

        const ctx = {
          filters,
          methodName,
        }

        return startCh.runStores(ctx, () => {
          wrapCallbackIfExist(args, ctx)

          // A callback query executes synchronously inside `method.apply`, so the
          // exec scope (and the deferred driver call it spawns) must be entered
          // here. A promise query defers execution to a later `exec`/`then`, which
          // is bound separately below.
          const res = callbackWrapped
            ? execCh.runStores(ctx, () => method.apply(this, args))
            : method.apply(this, args)

          // if it is not callback, wrap exec method and its then
          if (!callbackWrapped) {
            shimmer.wrap(res, 'exec', originalExec => {
              return function wrappedExec (...args) {
                if (!callbackWrapped) {
                  wrapCallbackIfExist(args, ctx)
                }

                const execResult = execCh.runStores(ctx, () => originalExec.apply(this, args))

                if (callbackWrapped || typeof execResult?.then !== 'function') {
                  return execResult
                }

                // wrap them method, wrap resolve and reject methods
                shimmer.wrap(execResult, 'then', originalThen => {
                  return function wrappedThen (...args) {
                    const resolve = args[0]
                    const reject = args[1]

                    if (typeof resolve === 'function') {
                      args[0] = shimmer.wrapCallback(resolve, resolve => function wrappedResolve (...args) {
                        finishCh.publish(ctx)
                        return resolve.apply(this, args)
                      })
                    }

                    if (typeof reject === 'function') {
                      args[1] = shimmer.wrapCallback(reject, reject => function wrappedReject (...args) {
                        finishCh.publish(ctx)
                        return reject.apply(this, args)
                      })
                    }

                    return originalThen.apply(this, args)
                  }
                })

                return execResult
              }
            })
          }
          return res
        })
      }
    })
  }

  return Model
})

const sanitizeFilterFinishCh = channel('datadog:mongoose:sanitize-filter:finish')

addHook({
  name: 'mongoose',
  versions: ['6', '>=7'],
  file: 'lib/helpers/query/sanitizeFilter.js',
}, sanitizeFilter => {
  return shimmer.wrapFunction(sanitizeFilter, sanitizeFilter => function wrappedSanitizeFilter (...args) {
    const sanitizedObject = sanitizeFilter.apply(this, args)

    if (sanitizeFilterFinishCh.hasSubscribers) {
      sanitizeFilterFinishCh.publish({
        sanitizedObject,
      })
    }

    return sanitizedObject
  })
})
