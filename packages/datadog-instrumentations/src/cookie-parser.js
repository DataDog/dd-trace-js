'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const cookieParserReadCh = channel('datadog:cookie-parser:read:finish')

function publishRequestCookieAndNext (req, res, next) {
  return function cookieParserWrapper () {
    if (cookieParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()

      const mergedCookies = Object.assign({}, req.cookies, req.signedCookies)

      cookieParserReadCh.publish({ req, res, abortController, cookies: mergedCookies })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  }
}

addHook({
  name: 'cookie-parser',
  versions: ['>=1.0.0']
}, cookieParser => {
  return shimmer.wrap(cookieParser, function () {
    const cookieMiddleware = cookieParser.apply(this, arguments)

    return shimmer.wrap(cookieMiddleware, function (req, res, next) {
      arguments[2] = publishRequestCookieAndNext(req, res, next)
      return cookieMiddleware.apply(this, arguments)
    })
  })
})
