'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const sessionMiddlewareFinishCh = channel('datadog:express-session:middleware:finish')

function wrapSessionMiddleware (sessionMiddleware) {
  return function wrappedSessionMiddleware (req, res, next) {
    shimmer.wrap(arguments, 2, function wrapNext (next) {
      return function wrappedNext () {
        if (sessionMiddlewareFinishCh.hasSubscribers) {
          const abortController = new AbortController()

          sessionMiddlewareFinishCh.publish({ req, res, sessionId: req.sessionID, abortController })

          if (abortController.signal.aborted) return
        }

        return next.apply(this, arguments)
      }
    })

    return sessionMiddleware.apply(this, arguments)
  }
}

function wrapSession (session) {
  return function wrappedSession () {
    const sessionMiddleware = session.apply(this, arguments)

    return shimmer.wrapFunction(sessionMiddleware, wrapSessionMiddleware)
  }
}

addHook({
  name: 'express-session',
  versions: ['>=1.5.0']
}, session => {
  return shimmer.wrapFunction(session, wrapSession)
})
