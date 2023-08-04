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
  if (mongoose.Promise !== global.Promise) {
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
  versions: ['>=4'],
  file: 'lib/model.js'
}, Model => {
  [...collectionMethodsWithFilter, ...collectionMethodsWithTwoFilters].forEach(methodName => {
    const useTwoArguments = collectionMethodsWithTwoFilters.includes(methodName)

    try {
      shimmer.wrap(Model, methodName, method => {
        return function () {
          if (!startCh.hasSubscribers) {
            return method.apply(this, arguments)
          }

          const asyncResource = new AsyncResource('bound-anonymous-fn')

          const filters = [arguments[0]]
          if (useTwoArguments) {
            filters.push(arguments[1])
          }

          const start = asyncResource.bind(function () {
            startCh.publish({
              filters,
              methodName
            })
          })
          const finish = asyncResource.bind(function () {
            finishCh.publish()
          })

          let callbackWrapped = false
          const lastArgumentIndex = arguments.length - 1

          if (typeof arguments[lastArgumentIndex] === 'function') {
            // is a callback, wrap it to execute finish()
            const originalCb = arguments[lastArgumentIndex]

            arguments[lastArgumentIndex] = shimmer.wrap(originalCb, function () {
              finish()
              originalCb.apply(this, arguments)
            })

            callbackWrapped = true
          }

          return asyncResource.runInAsyncScope(() => {
            if (callbackWrapped) {
              start()
            }

            const res = method.apply(this, arguments)
            if (!callbackWrapped) {
              // if it is not callback, wrap exec method and its then
              const originalExec = res.exec

              res.exec = shimmer.wrap(originalExec, function () {
                start()

                const execResult = originalExec.apply(this, arguments)

                // wrap them method, wrap resolve and reject methods
                const originalThen = execResult.then
                execResult.then = shimmer.wrap(originalThen, function () {
                  const resolve = arguments[0]
                  const reject = arguments[1]

                  // not using shimmer here because resolve/reject could be empty
                  arguments[0] = function () {
                    finish()
                    if (resolve) {
                      resolve.apply(this, arguments)
                    }
                  }

                  arguments[1] = function () {
                    finish()
                    if (reject) {
                      reject.apply(this, arguments)
                    }
                  }

                  return originalThen.apply(this, arguments)
                })

                return execResult
              })
            }
            return res
          })
        }
      })
    } catch (e) {
      // if method does not exist, do nothing
    }
  })

  return Model
})
