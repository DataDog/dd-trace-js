'use strict'

const shimmer = require('../../datadog-shimmer')
const { AbortController } = require('node-abort-controller')
const { channel, addHook } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish(username, password, verified) {
  if (passportVerifyChannel.hasSubscribers) {
    const abortController = new AbortController()

    return shimmer.wrap(verified, (err, user, info) => {
      // TODO: check if err and info are really useful
      passportVerifyChannel.publish({ username, user, err, info, abortController })
      return verified(err, user, info)
    })
  }
}

function wrapVerify(verify, passReq) {
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
    if (typeof arguments[0] == 'function') {
      arguments[0] = wrapVerify(arguments[0], false)
    } else {
      arguments[1] = wrapVerify(arguments[1], arguments[0].passReqToCallback || false)
    }
    Strategy.apply(this, arguments)
  })
})
