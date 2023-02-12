'use strict'

const { AbortController } = require('node-abort-controller') // AbortController is not available in node <15
const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const cookieParserReadCh = channel('datadog:cookie-parser:read:finish')

function publishCookieReadedAndNext (req, res, next) {
  return function () {
    if (cookieParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      cookieParserReadCh.publish({ req, res, abortController })
      if (abortController.signal.aborted) {
        res.end()
        return
      }
    }
    next.apply(this, arguments)
  }
}

addHook({
  name: 'cookie-parser',
  versions: ['>=1.0.0']
}, cookieParser => {
  const wrappedCookieParser = shimmer.wrap(cookieParser, function () {
    const middleware = cookieParser.apply(this, arguments)
    return shimmer.wrap(middleware, function (req, res, next) {
      const nextResource = new AsyncResource('bound-anonymous-fn')
      arguments[2] = nextResource.bind(publishCookieReadedAndNext(req, res, next))
      middleware.apply(this, arguments)
    })
  })
  return wrappedCookieParser
})
