'use strict'

const { createWrapRouterMethod } = require('./router')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

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

const responseJsonChannel = channel('datadog:express:response:json:start')

function wrapResponseJson (json) {
  return function wrappedJson (obj) {
    if (responseJsonChannel.hasSubscribers) {
      // backward compat as express 4.x supports deprecated 3.x signature
      if (arguments.length === 2 && typeof arguments[1] !== 'number') {
        obj = arguments[1]
      }

      responseJsonChannel.publish({ req: this.req, body: obj })
    }

    return json.apply(this, arguments)
  }
}

addHook({ name: 'express', versions: ['>=4'] }, express => {
  shimmer.wrap(express.application, 'handle', wrapHandle)
  shimmer.wrap(express.Router, 'use', wrapRouterMethod)
  shimmer.wrap(express.Router, 'route', wrapRouterMethod)

  shimmer.wrap(express.response, 'json', wrapResponseJson)
  shimmer.wrap(express.response, 'jsonp', wrapResponseJson)

  return express
})

const queryParserReadCh = channel('datadog:query:read:finish')

function publishQueryParsedAndNext (req, res, next) {
  return function () {
    if (queryParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const query = req.query

      queryParserReadCh.publish({ req, res, query, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
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

const processParamsStartCh = channel('datadog:express:process_params:start')
const wrapProcessParamsMethod = (requestPositionInArguments) => {
  return (original) => {
    return function () {
      if (processParamsStartCh.hasSubscribers) {
        processParamsStartCh.publish({ req: arguments[requestPositionInArguments] })
      }

      return original.apply(this, arguments)
    }
  }
}

addHook({ name: 'express', versions: ['>=4.0.0 <4.3.0'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(1))
  return express
})

addHook({ name: 'express', versions: ['>=4.3.0'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(2))
  return express
})
