'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const bodyParserReadCh = channel('datadog:body-parser:read:finish')

function publishRequestBodyAndNext (req, res, next) {
  return shimmer.wrapFunction(next, next => function () {
    if (bodyParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const body = req.body

      bodyParserReadCh.publish({ req, res, body, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  })
}

addHook({
  name: 'body-parser',
  file: 'lib/read.js',
  versions: ['>=1.4.0 <1.20.0']
}, read => {
  return shimmer.wrapFunction(read, read => function (req, res, next) {
    // Skip body parsing if body has already been meaningfully parsed by any middleware
    if (req.body !== undefined && req.body !== null &&
        ((typeof req.body === 'object' && Object.keys(req.body).length > 0) ||
         (typeof req.body === 'string' && req.body.length > 0))) {
      // Still publish the channel so AppSec and IAST can process the body
      if (bodyParserReadCh.hasSubscribers && req) {
        const abortController = new AbortController()
        const body = req.body
        bodyParserReadCh.publish({ req, res, body, abortController })
        if (abortController.signal.aborted) return
      }
      return next()
    }
    const nextResource = new AsyncResource('bound-anonymous-fn')
    arguments[2] = nextResource.bind(publishRequestBodyAndNext(req, res, next))
    return read.apply(this, arguments)
  })
})

addHook({
  name: 'body-parser',
  file: 'lib/read.js',
  versions: ['>=1.20.0']
}, read => {
  return shimmer.wrapFunction(read, read => function (req, res, next) {
    // Skip body parsing if body has already been meaningfully parsed by any middleware
    if (req.body !== undefined && req.body !== null &&
        ((typeof req.body === 'object' && Object.keys(req.body).length > 0) ||
         (typeof req.body === 'string' && req.body.length > 0))) {
      // Still publish the channel so AppSec and IAST can process the body
      if (bodyParserReadCh.hasSubscribers && req) {
        const abortController = new AbortController()
        const body = req.body
        bodyParserReadCh.publish({ req, res, body, abortController })
        if (abortController.signal.aborted) return
      }
      return next()
    }
    arguments[2] = publishRequestBodyAndNext(req, res, next)
    return read.apply(this, arguments)
  })
})
