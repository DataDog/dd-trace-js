'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, password, verified, type) {
  if (!passportVerifyChannel.hasSubscribers) {
    return verified
  }

  // eslint-disable-next-line n/handle-callback-err
  return shimmer.wrapFunction(verified, verified => function (err, user, info) {
    const credentials = { type, username }
    passportVerifyChannel.publish({ credentials, user })
    return verified.apply(this, arguments)
  })
}

function wrapVerify (verify, passReq) {
  if (passReq) {
    return function (req, username, password, verified) {
      arguments[3] = wrapVerifiedAndPublish(username, password, verified, this.name)
      return verify.apply(this, arguments)
    }
  } else {
    return function (username, password, verified) {
      arguments[2] = wrapVerifiedAndPublish(username, password, verified, this.name)
      return verify.apply(this, arguments)
    }
  }
}

function wrapStrategy (Strategy) {
  return function wrappedStrategy () {
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0], false)
    } else {
      arguments[1] = wrapVerify(arguments[1], (arguments[0] && arguments[0].passReqToCallback))
    }
    return Strategy.apply(this, arguments)
  }
}

return function strategyHook (Strategy) {
  return shimmer.wrapFunction(Strategy, wrapStrategy)
}

module.exports = {
  strategyHook
}
