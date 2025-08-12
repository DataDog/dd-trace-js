'use strict'

const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

const startRawQueryCh = channel('datadog:knex:raw:start')
const rawQuerySubscribes = channel('datadog:knex:raw:subscribes')
const finishRawQueryCh = channel('datadog:knex:raw:finish')

patch('lib/query/builder.js')
patch('lib/raw.js')
patch('lib/schema/builder.js')

function patch (file) {
  addHook({
    name: 'knex',
    versions: ['>=0.8.0'],
    file
  }, Builder => {
    shimmer.wrap(Builder.prototype, 'then', wrapThen)
    return Builder
  })
}

function finish (context, cb) {
  finishRawQueryCh.runStores(context, cb)
}

addHook({
  name: 'knex',
  versions: ['>=2'],
  file: 'lib/knex-builder/Knex.js'
}, Knex => {
  shimmer.wrap(Knex.Client.prototype, 'raw', raw => function () {
    if (!startRawQueryCh.hasSubscribers) {
      return raw.apply(this, arguments)
    }

    const sql = arguments[0]

    // Skip query done by Knex to get the value used for undefined
    if (sql === 'DEFAULT') {
      return raw.apply(this, arguments)
    }

    const context = { sql, dialect: this.dialect }
    return startRawQueryCh.runStores(context, () => {
      const rawResult = raw.apply(this, arguments)
      shimmer.wrap(rawResult, 'then', originalThen => function () {
        return rawQuerySubscribes.runStores(context, () => {
          arguments[0] = wrapCallbackWithFinish(arguments[0], finish, context)
          if (arguments[1]) arguments[1] = wrapCallbackWithFinish(arguments[1], finish, context)

          const originalThenResult = originalThen.apply(this, arguments)

          shimmer.wrap(originalThenResult, 'catch', originalCatch => function () {
            arguments[0] = wrapCallbackWithFinish(arguments[0], finish, context)
            return originalCatch.apply(this, arguments)
          })

          return originalThenResult
        })
      })

      shimmer.wrap(rawResult, 'asCallback', originalAsCallback => function () {
        return rawQuerySubscribes.runStores(context, () => {
          arguments[0] = wrapCallbackWithFinish(arguments[0], finish, context)
          return originalAsCallback.apply(this, arguments)
        })
      })

      return rawResult
    })
  })

  return Knex
})

function wrapCallbackWithFinish (callback, finish, context) {
  if (typeof callback !== 'function') return callback

  return shimmer.wrapFunction(callback, callback => function () {
    finish(context, () => callback.apply(this, arguments))
  })
}
