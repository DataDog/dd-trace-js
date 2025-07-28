'use strict'

const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('datadog:mongoose:model:filter:start')
const finishCh = channel('datadog:mongoose:model:filter:finish')
// this channel is for wrapping the callback of exec methods and handling store context
const addQueueCh = channel('datadog:mongoose:collection:addQueue')

function wrapAddQueue (addQueue) {
  const ctx = {}
  return addQueueCh.runStores(ctx, () => {
    return function addQueueWithTrace (name) {
      return addQueue.apply(this, arguments)
    }
  })
}

addHook({
  name: 'mongoose',
  versions: ['>=4.6.4 <5', '5', '6', '>=7']
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
  'remove'
]

const collectionMethodsWithTwoFilters = [
  'findOneAndUpdate',
  'updateMany',
  'updateOne'
]

addHook({
  name: 'mongoose',
  versions: ['>=4.6.4 <5', '5', '6', '>=7'],
  file: 'lib/model.js'
}, Model => {
  [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters].forEach(methodName => {
    const useTwoArguments = collectionMethodsWithTwoFilters.includes(methodName)
    if (!(methodName in Model)) return

    shimmer.wrap(Model, methodName, method => {
      return function wrappedModelMethod () {
        if (!startCh.hasSubscribers) {
          return method.apply(this, arguments)
        }

        const filters = [arguments[0]]
        if (useTwoArguments) {
          filters.push(arguments[1])
        }

        let callbackWrapped = false

        const wrapCallbackIfExist = (args, ctx) => {
          const lastArgumentIndex = args.length - 1

          if (typeof args[lastArgumentIndex] === 'function') {
            // is a callback, wrap it to execute finish()
            shimmer.wrap(args, lastArgumentIndex, originalCb => {
              return function () {
                finishCh.publish(ctx)

                return originalCb.apply(this, arguments)
              }
            })

            callbackWrapped = true
          }
        }

        const ctx = {
          filters,
          methodName
        }

        return startCh.runStores(ctx, () => {
          wrapCallbackIfExist(arguments, ctx)

          const res = method.apply(this, arguments)

          // if it is not callback, wrap exec method and its then
          if (!callbackWrapped) {
            shimmer.wrap(res, 'exec', originalExec => {
              return function wrappedExec () {
                if (!callbackWrapped) {
                  wrapCallbackIfExist(arguments, ctx)
                }

                const execResult = originalExec.apply(this, arguments)

                if (callbackWrapped || typeof execResult?.then !== 'function') {
                  return execResult
                }

                // wrap them method, wrap resolve and reject methods
                shimmer.wrap(execResult, 'then', originalThen => {
                  return function wrappedThen () {
                    const resolve = arguments[0]
                    const reject = arguments[1]

                    arguments[0] = shimmer.wrapFunction(resolve, resolve => function wrappedResolve () {
                      finishCh.publish(ctx)

                      if (resolve) {
                        return resolve.apply(this, arguments)
                      }
                    })

                    arguments[1] = shimmer.wrapFunction(reject, reject => function wrappedReject () {
                      finishCh.publish(ctx)

                      if (reject) {
                        return reject.apply(this, arguments)
                      }
                    })

                    return originalThen.apply(this, arguments)
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
  })

  return Model
})

const sanitizeFilterFinishCh = channel('datadog:mongoose:sanitize-filter:finish')

addHook({
  name: 'mongoose',
  versions: ['6', '>=7'],
  file: 'lib/helpers/query/sanitizeFilter.js'
}, sanitizeFilter => {
  return shimmer.wrapFunction(sanitizeFilter, sanitizeFilter => function wrappedSanitizeFilter () {
    const sanitizedObject = sanitizeFilter.apply(this, arguments)

    if (sanitizeFilterFinishCh.hasSubscribers) {
      sanitizeFilterFinishCh.publish({
        sanitizedObject
      })
    }

    return sanitizedObject
  })
})
