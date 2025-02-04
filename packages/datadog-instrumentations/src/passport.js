'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const onPassportDeserializeUserChannel = channel('datadog:passport:deserializeUser:finish')

function wrapDone (done) {
  return function wrappedDone (err, user) {
    if (!err && user) {
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
  versions: ['>=0.3.0']
}, Authenticator => {
  shimmer.wrap(Authenticator.prototype, 'deserializeUser', wrapDeserializeUser)

  return Authenticator
})
