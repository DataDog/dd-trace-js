'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, password, verified) {
  if (passportVerifyChannel.hasSubscribers) {
    return shimmer.wrap(verified, function (err, user, info) {
      const credentials = { type: 'http', username }
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
  name: 'passport-http',
  file: 'lib/passport-http/strategies/basic.js',
  versions: ['>=0.3.0']
}, BasicStrategy => {
  return shimmer.wrap(BasicStrategy, function () {
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false)
    } else {
      arguments[1] = wrapVerify(arguments[1], (arguments[0] && arguments[0].passReqToCallback))
    }
    return BasicStrategy.apply(this, arguments)
  })
})
