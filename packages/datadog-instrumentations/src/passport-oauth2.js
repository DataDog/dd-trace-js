'use strict'

const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')
const { channel, addHook } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (profile, verified) {
  if (passportVerifyChannel.hasSubscribers) {
    const abortController = new AbortController()

    return shimmer.wrap(verified, (err, user, info) => {
      // TODO: check if err and info are really useful
      const username = profile.id
      passportVerifyChannel.publish({ username, user, err, info, abortController })
      return verified(err, user, info)
    })
  }
}

function wrapVerify (verify, passReq) {
  // TODO: Verify function can also take an additional argument (params) which is not controlled by a fature flag like
  // in the case of passing the request object. Check if that argumet can contain useful information for automated login
  // events feature.
  const arity = verify.length
  if (passReq) {
    if (arity === 6) {
      return function (req, accessToken, refreshToken, params, profile, verified) {
        arguments[3] = wrapVerifiedAndPublish(profile, verified)
        return verify.apply(this, arguments)
      }
    } else {
      return function (req, accessToken, refreshToken, profile, verified) {
        arguments[3] = wrapVerifiedAndPublish(profile, verified)
        return verify.apply(this, arguments)
      }
    }
  } else {
    if (arity === 5) {
      return function (accessToken, refreshToken, params, profile, verified) {
        arguments[2] = wrapVerifiedAndPublish(profile, verified)
        return verify.apply(this, arguments)
      }
    } else {
      return function (accessToken, refreshToken, profile, verified) {
        arguments[2] = wrapVerifiedAndPublish(profile, verified)
        return verify.apply(this, arguments)
      }
    }
  }
}

addHook({
  name: 'passport-oauth2',
  file: 'lib/strategy.js',
  versions: ['>=1.0.0']
}, Oauth2Strategy => {
  return shimmer.wrap(Oauth2Strategy, function () {
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false)
    } else {
      arguments[1] = wrapVerify(arguments[1], arguments[0].passReqToCallback || false)
    }
    Oauth2Strategy.apply(this, arguments)
  })
})
