'use strict'

const { AsyncResource } = require('async_hooks')
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

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    function onFinish () {
      asyncResource.bind(function () {
        finishRawQueryCh.publish()
      }, this).apply(this)
    }

    startRawQueryCh.publish({ sql })

    const rawResult = raw.apply(this, arguments)
    wrapThenRaw(rawResult.then, onFinish, asyncResource)

    return rawResult
  })
  return Knex
})

function wrapThenRaw (origThen, onFinish, ar) {
  return function then (onFulfilled, onRejected, onProgress) {
    arguments[0] = wrapCallback(ar, onFulfilled, onFinish)
    arguments[1] = wrapCallback(ar, onRejected, onFinish)

    // not standard but sometimes supported
    if (onProgress) {
      arguments[2] = wrapCallback(ar, onProgress, onFinish)
    }

    return origThen.apply(this, arguments)
  }
}

function wrapCallback (ar, callback, onFinish) {
  if (typeof callback !== 'function') return callback

  return function () {
    return ar.runInAsyncScope(() => {
      onFinish()
      return callback.apply(this, arguments)
    })
  }
}
