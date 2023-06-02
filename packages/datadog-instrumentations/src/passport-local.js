'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, password, verified) {
  if (passportVerifyChannel.hasSubscribers) {
    return shimmer.wrap(verified, function (err, user, info) {
      const credentials = { type: 'local', username, password }
      passportVerifyChannel.publish({ credentials, user })
      return verified.call(this, err, user, info)
    })
  } else {
    return verified
  }
}

function wrapVerify (verify, passReq) {
  if (passReq) {
    return function (req, username, password, verified) {
      arguments[3] = wrapVerifiedAndPublish(username, password, verified)
      return verify.apply(this, arguments)
    }
  } else {
    return function (username, password, verified) {
      arguments[2] = wrapVerifiedAndPublish(username, password, verified)
      return verify.apply(this, arguments)
    }
  }
}

addHook({
  name: 'passport-local',
  file: 'lib/strategy.js',
  versions: ['>=1.0.0']
}, Strategy => {
  return shimmer.wrap(Strategy, function () {
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false)
    } else {
      arguments[1] = wrapVerify(arguments[1], (arguments[0] && arguments[0].passReqToCallback) || false)
    }
    return Strategy.apply(this, arguments)
  })
})
