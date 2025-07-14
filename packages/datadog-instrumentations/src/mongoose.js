'use strict'

const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')

function wrap (fn, store) {
  if (typeof fn !== 'function') return fn
  return function () {
    storage('legacy').enterWith(store)
    return fn.apply(this, arguments)
  }
}

function wrapExec (exec) {
  return function (op, callback) {
    if (typeof op === 'function') {
      callback = op
      op = undefined
    }

    if (typeof callback === 'function') {
      const store = storage('legacy').getStore()
      const bound = wrap(callback, store)

      if (op === undefined) {
        return exec.call(this, bound)
      } else {
        return exec.call(this, op, bound)
      }
    }

    return exec.apply(this, arguments)
  }
}

addHook({
  name: 'mongoose',
  versions: ['>=4.6.4 <5', '5', '6', '>=7']
}, mongoose => {
  // As of Mongoose 7, custom promise libraries are no longer supported and mongoose.Promise may be undefined
  if (mongoose.Promise && mongoose.Promise !== global.Promise) {
    shimmer.wrap(mongoose.Promise.prototype, 'then', wrapThen)
  }

  if (mongoose.Query) {
    shimmer.wrap(mongoose.Query.prototype, 'exec', wrapExec)
  }

  if (mongoose.Aggregate) {
    shimmer.wrap(mongoose.Aggregate.prototype, 'exec', wrapExec)
  }

  // The `addQueue` function is used internally to execute buffered operations.
  // We need to wrap it to make sure the context is propagated to the functions
  // it executes.
  if (mongoose.Collection) {
    shimmer.wrap(mongoose.Collection.prototype, 'addQueue', function (addQueue) {
      return function (name, args, options) {
        if (typeof name === 'function') {
          arguments[0] = wrap(name, storage('legacy').getStore())
        }
        return addQueue.apply(this, arguments)
      }
    })
  }

  return mongoose
})

const startCh = channel('datadog:mongoose:model:filter:start')
const finishCh = channel('datadog:mongoose:model:filter:finish')

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
                  wrapCallbackIfExist(arguments)
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
