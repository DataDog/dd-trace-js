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

function wrapThenRaw (origThen, onFinish, asyncResource) {
  return function () {
    const onFulfilled = arguments[0]
    const onRejected = arguments[1]

    // not using shimmer here because resolve/reject could be empty
    arguments[0] = function () {
      asyncResource.runInAsyncScope(() => {
        onFinish()

        if (onFulfilled) {
          onFulfilled.apply(this, arguments)
        }
      })
    }

    arguments[1] = function () {
      asyncResource.runInAsyncScope(() => {
        onFinish()

        if (onRejected) {
          onRejected.apply(this, arguments)
        }
      })
    }

    return origThen.apply(this, arguments)
  }
}
