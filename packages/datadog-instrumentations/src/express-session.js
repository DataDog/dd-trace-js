'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const sessionMiddlewareFinishCh = channel('datadog:express-session:middleware:finish')

function wrapSessionMiddleware (sessionMiddleware) {
  return function wrappedSessionMiddleware (...args) {
    const req = args[0]
    const res = args[1]
    shimmer.wrap(args, 2, function wrapNext (next) {
      return function wrappedNext (...nextArgs) {
        if (sessionMiddlewareFinishCh.hasSubscribers) {
          const abortController = new AbortController()

          sessionMiddlewareFinishCh.publish({ req, res, sessionId: req.sessionID, abortController })

          if (abortController.signal.aborted) return
        }

        return Reflect.apply(next, this, nextArgs)
      }
    })

    return Reflect.apply(sessionMiddleware, this, args)
  }
}

function wrapSession (session) {
  return function wrappedSession (...args) {
    const sessionMiddleware = session.apply(this, args)

    return shimmer.wrapFunction(sessionMiddleware, wrapSessionMiddleware)
  }
}

addHook({
  name: 'express-session',
  versions: ['>=1.5.0'],
}, session => {
  return shimmer.wrapFunction(session, wrapSession)
})
