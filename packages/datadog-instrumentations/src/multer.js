'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const multerReadCh = channel('datadog:multer:read:finish')

function publishRequestBodyAndNext (req, res, next) {
  // Mirror next's name/arity so wrapCallback skips its per-call identity rewrite.
  return shimmer.wrapCallback(next, original => function next (_error) {
    if (multerReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const body = req.body

      multerReadCh.publish({ req, res, body, abortController })

      if (abortController.signal.aborted) return
    }

    return original.apply(this, arguments)
  })
}

addHook({
  name: 'multer',
  file: 'lib/make-middleware.js',
  versions: ['^1.4.4-lts.1'],
}, makeMiddleware => {
  return shimmer.wrapFunction(makeMiddleware, makeMiddleware => function (...args) {
    const middleware = makeMiddleware.apply(this, args)

    return shimmer.wrapFunction(middleware, middleware => function wrapMulterMiddleware (req, res, next) {
      const nextResource = new AsyncResource('bound-anonymous-fn')
      arguments[2] = nextResource.bind(publishRequestBodyAndNext(req, res, next))
      return middleware.apply(this, arguments)
    })
  })
})
