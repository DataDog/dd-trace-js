'use strict'

const { createWrapRouterMethod } = require('./router')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const { AbortController } = require('node-abort-controller')

const handleChannel = channel('apm:express:request:handle')

function wrapHandle (handle) {
  return function handleWithTrace (req, res) {
    if (handleChannel.hasSubscribers) {
      handleChannel.publish({ req })
    }

    return handle.apply(this, arguments)
  }
}

const wrapRouterMethod = createWrapRouterMethod('express')

addHook({ name: 'express', versions: ['>=4'] }, express => {
  shimmer.wrap(express.application, 'handle', wrapHandle)
  shimmer.wrap(express.Router, 'use', wrapRouterMethod)
  shimmer.wrap(express.Router, 'route', wrapRouterMethod)

  return express
})

const queryParserReadCh = channel('datadog:query:read:finish')

function publishQueryParsedAndNext (req, res, next) {
  return function () {
    if (queryParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()

      queryParserReadCh.publish({ req, res, abortController })

      if (abortController.signal.aborted) return
    }

    next.apply(this, arguments)
  }
}

addHook({
  name: 'express',
  versions: ['>=4'],
  file: 'lib/middleware/query.js'
}, query => {
  return shimmer.wrap(query, function () {
    const queryMiddleware = query.apply(this, arguments)

    return shimmer.wrap(queryMiddleware, function (req, res, next) {
      arguments[2] = publishQueryParsedAndNext(req, res, next)
      return queryMiddleware.apply(this, arguments)
    })
  })
})
