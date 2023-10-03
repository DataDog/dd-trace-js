'use strict'

const { addHook, channel } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

const startRawQueryCh = channel('datadog:knex:raw:start')
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

    function finish () {
      finishRawQueryCh.publish()
    }

    startRawQueryCh.publish({ sql, dialect: this.dialect })

    const rawResult = raw.apply(this, arguments)

    shimmer.wrap(rawResult, 'then', originalThen => function () {
      arguments[0] = wrapCallbackWithFinish(arguments[0], finish)
      arguments[1] = wrapCallbackWithFinish(arguments[1], finish)

      const originalThenResult = originalThen.apply(this, arguments)

      shimmer.wrap(originalThenResult, 'catch', originalCatch => function () {
        arguments[0] = wrapCallbackWithFinish(arguments[0], finish)
        return originalCatch.apply(this, arguments)
      })

      return originalThenResult
    })

    shimmer.wrap(rawResult, 'asCallback', originalAsCallback => function () {
      arguments[0] = wrapCallbackWithFinish(arguments[0], finish)
      return originalAsCallback.apply(this, arguments)
    })

    return rawResult
  })
  return Knex
})

function wrapCallbackWithFinish (callback, finish) {
  if (typeof callback !== 'function') return callback

  return function () {
    finish()
    callback.apply(this, arguments)
  }
}
