'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

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

const onPassportDeserializeUserChannel = channel('datadog:passport:deserializeUser:finish')

function wrapDone (done) {
  // eslint-disable-next-line n/handle-callback-err
  return function wrappedDone (err, user) {
    if (user) {
      const abortController = new AbortController()

      onPassportDeserializeUserChannel.publish({ user, abortController })

      if (abortController.signal.aborted) return
    }

    return done.apply(this, arguments)
  }
}

function wrapDeserializeUser (deserializeUser) {
  return function wrappedDeserializeUser (fn, req, done) {
    if (typeof fn === 'function') return deserializeUser.apply(this, arguments)

    if (typeof req === 'function') {
      done = req
      arguments[1] = wrapDone(done)
    } else {
      arguments[2] = wrapDone(done)
    }

    return deserializeUser.apply(this, arguments)
  }
}

addHook({
  name: 'passport',
  file: 'lib/authenticator.js',
  versions: ['>=0.2.0']
}, Authenticator => {
  shimmer.wrap(Authenticator.prototype, 'deserializeUser', wrapDeserializeUser)

  return Authenticator
})
