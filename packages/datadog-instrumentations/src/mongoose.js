'use strict'

const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const { AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function wrapAddQueue (addQueue) {
  return function addQueueWithTrace (name) {
    if (typeof name === 'function') {
      arguments[0] = AsyncResource.bind(name)
    } else if (typeof this[name] === 'function') {
      arguments[0] = AsyncResource.bind((...args) => this[name](...args))
    }

    return addQueue.apply(this, arguments)
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

  shimmer.wrap(mongoose.Collection.prototype, 'addQueue', wrapAddQueue)

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

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        const filters = [arguments[0]]
        if (useTwoArguments) {
          filters.push(arguments[1])
        }

        const finish = asyncResource.bind(function () {
          finishCh.publish()
        })

        let callbackWrapped = false

        const wrapCallbackIfExist = (args) => {
          const lastArgumentIndex = args.length - 1

          if (typeof args[lastArgumentIndex] === 'function') {
            // is a callback, wrap it to execute finish()
            shimmer.wrap(args, lastArgumentIndex, originalCb => {
              return function () {
                finish()

                return originalCb.apply(this, arguments)
              }
            })

            callbackWrapped = true
          }
        }

        wrapCallbackIfExist(arguments)

        return asyncResource.runInAsyncScope(() => {
          startCh.publish({
            filters,
            methodName
          })

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

                    // not using shimmer here because resolve/reject could be empty
                    arguments[0] = function wrappedResolve () {
                      finish()

                      if (resolve) {
                        return resolve.apply(this, arguments)
                      }
                    }

                    arguments[1] = function wrappedReject () {
                      finish()

                      if (reject) {
                        return reject.apply(this, arguments)
                      }
                    }

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
  return shimmer.wrap(sanitizeFilter, function wrappedSanitizeFilter () {
    const sanitizedObject = sanitizeFilter.apply(this, arguments)

    if (sanitizeFilterFinishCh.hasSubscribers) {
      sanitizeFilterFinishCh.publish({
        sanitizedObject
      })
    }

    return sanitizedObject
  })
})
