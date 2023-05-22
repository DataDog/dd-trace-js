'use strict'

const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')
const { channel, addHook } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (payload, verified) {
  if (passportVerifyChannel.hasSubscribers) {
    const abortController = new AbortController()

    return shimmer.wrap(verified, (err, user, info) => {
      // TODO: check if err and info are really useful
      const username = payload.sub || 'unknown'
      passportVerifyChannel.publish({ username, user, err, info, abortController })
      return verified(err, user, info)
    })
  }
}

function wrapVerify (verify, passReq) {
  if (passReq) {
    return function (req, payload, verified) {
      arguments[2] = wrapVerifiedAndPublish(payload, verified)
      return verify.apply(this, arguments)
    }
  } else {
    return function (payload, verified) {
      arguments[1] = wrapVerifiedAndPublish(payload, verified)
      return verify.apply(this, arguments)
    }
  }
}

addHook({
  name: 'passport-jwt',
  file: 'lib/strategy.js',
  versions: ['>=1.0.0']
}, JwtStrategy => {
  return shimmer.wrap(JwtStrategy, function () {
    arguments[1] = wrapVerify(arguments[1], arguments[0].passReqToCallback || false)
    JwtStrategy.apply(this, arguments)
  })
})
