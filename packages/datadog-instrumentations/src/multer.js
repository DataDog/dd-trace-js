'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const multerReadCh = channel('datadog:multer:read:finish')

function publishRequestBodyAndNext (req, res, next) {
  return shimmer.wrapFunction(next, next => function () {
    if (multerReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const body = req.body

      multerReadCh.publish({ req, res, body, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  })
}

addHook({
  name: 'multer',
  file: 'lib/make-middleware.js',
  versions: ['^1.4.4-lts.1']
}, makeMiddleware => {
  return shimmer.wrapFunction(makeMiddleware, makeMiddleware => function () {
    const middleware = makeMiddleware.apply(this, arguments)

    return shimmer.wrapFunction(middleware, middleware => function wrapMulterMiddleware (req, res, next) {
      const nextResource = new AsyncResource('bound-anonymous-fn')
      arguments[2] = nextResource.bind(publishRequestBodyAndNext(req, res, next))
      return middleware.apply(this, arguments)
    })
  })
})
