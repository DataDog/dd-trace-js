'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

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
  versions: ['>=0.3.0'] // TODO
}, session => {
  return shimmer.wrapFunction(session, wrapSession)
})


  return shimmer.wrapFunction(session, function wrapSession {
      const queryMiddleware = query.apply(this, arguments)

      return shimmer.wrapFunction(queryMiddleware, queryMiddleware => function (req, res, next) {
      arguments[2] = publishQueryParsedAndNext(req, res, next)
      return queryMiddleware.apply(this, arguments)
    })
  })