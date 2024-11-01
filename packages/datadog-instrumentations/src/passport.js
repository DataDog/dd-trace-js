'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

/* TODO: test with:
passport-jwt JWTs
  can be used both for login events, or as a session, that complicates things it think
  maybe instrument this lib directly, and ofc only send the events after it was verified
@nestjs/passport
pasport-local
passport-oauth2
passport-google-oauth20
passport-custom
passport-http
passport-http-bearer
koa-passport
*/

function wrapDone (done) {
  // eslint-disable-next-line n/handle-callback-err
  return function wrappedDone (err, user) {
    if (user) {
      const abortController = new AbortController()

      // express-session middleware sets req.sessionID, it's required to use passport sessions anyway so might as well use it ?
      // what if session IDs are using rolling sessions or always changing or something idk ?
      channel.publish({ req, user, sessionId: req.sessionID, abortController })

      if (abortController.signal.aborted) return
    }

    return done.apply(this, arguments)
  }
}

function wrapDeserializeUser (deserializeUser) {
  return function wrappedDeserializeUser (fn, req, done) {
    if (typeof req === 'function') {
      done = req
      // req = storage.getStore().get('req')
      arguments[1] = wrapDone(done)
    } else {
      arguments[2] = wrapDone(done)
    }

    return deserializeUser.apply(this, arguments)
  }
}


const { block } = require('../../dd-trace/src/appsec/blocking')
const { getRootSpan } = require('../../dd-trace/src/appsec/sdk/utils')

addHook({
  name: 'passport',
  file: 'lib/authenticator.js',
  versions: ['>=0.3.0'] // TODO
}, Authenticator => {
  shimmer.wrap(Authenticator.prototype, 'deserializeUser', wrapDeserializeUser)

  shimmer.wrap(Authenticator.prototype, 'authenticate', function wrapAuthenticate (authenticate) {
    return function wrappedAuthenticate (name) {
      const middleware = authenticate.apply(this, arguments)

      const strategy = this._strategy(name)

      strategy._verify

      return function wrappedMiddleware (req, res, next) {
        return middleware(req, res, function wrappedNext (err) {
          console.log('NEW', req.user)
          if (req.user?.name === 'bitch') {

            return block(req, res, getRootSpan(global._ddtrace))
          }

          return next.apply(this, arguments)
        })
      }
    }
  })

  return Authenticator
})
