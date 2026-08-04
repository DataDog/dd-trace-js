'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const cookieParserReadCh = channel('datadog:cookie-parser:read:finish')

function publishRequestCookieAndNext (req, res, next) {
  // Mirror next's name/arity so wrapCallback skips its per-call identity rewrite.
  return shimmer.wrapCallback(next, original => function next (_error) {
    if (cookieParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()

      const mergedCookies = { ...req.cookies, ...req.signedCookies }

      cookieParserReadCh.publish({ req, res, abortController, cookies: mergedCookies })

      if (abortController.signal.aborted) return
    }

    return original.apply(this, arguments)
  })
}

addHook({
  name: 'cookie-parser',
  versions: ['>=1.0.0'],
}, cookieParser => {
  return shimmer.wrapFunction(cookieParser, cookieParser => function (...args) {
    const cookieMiddleware = cookieParser.apply(this, args)

    return shimmer.wrapFunction(cookieMiddleware, cookieMiddleware => function (req, res, next) {
      arguments[2] = publishRequestCookieAndNext(req, res, next)
      return cookieMiddleware.apply(this, arguments)
    })
  })
})
