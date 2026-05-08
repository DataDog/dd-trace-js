'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

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
    file,
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
  file: 'lib/knex-builder/Knex.js',
}, Knex => {
  shimmer.wrap(Knex.Client.prototype, 'raw', raw => function (...args) {
    if (!startRawQueryCh.hasSubscribers) {
      return raw.apply(this, args)
    }

    const sql = args[0]

    // Skip query done by Knex to get the value used for undefined
    if (sql === 'DEFAULT') {
      return raw.apply(this, args)
    }

    const context = { sql, dialect: this.dialect }
    return startRawQueryCh.runStores(context, () => {
      const rawResult = raw.apply(this, args)
      shimmer.wrap(rawResult, 'then', originalThen => function (...args) {
        return rawQuerySubscribes.runStores(context, () => {
          args[0] = wrapCallbackWithFinish(args[0], finish, context)
          if (args[1]) args[1] = wrapCallbackWithFinish(args[1], finish, context)

          const originalThenResult = originalThen.apply(this, args)

          shimmer.wrap(originalThenResult, 'catch', originalCatch => function (...args) {
            args[0] = wrapCallbackWithFinish(args[0], finish, context)
            return originalCatch.apply(this, args)
          })

          return originalThenResult
        })
      })

      shimmer.wrap(rawResult, 'asCallback', originalAsCallback => function (...args) {
        return rawQuerySubscribes.runStores(context, () => {
          args[0] = wrapCallbackWithFinish(args[0], finish, context)
          return originalAsCallback.apply(this, args)
        })
      })

      return rawResult
    })
  })

  return Knex
})

function wrapCallbackWithFinish (callback, finish, context) {
  if (typeof callback !== 'function') return callback

  return shimmer.wrapFunction(callback, callback => function (...args) {
    finish(context, () => callback.apply(this, args))
  })
}
