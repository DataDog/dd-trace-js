'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, verified) {
  return shimmer.wrapFunction(verified, function wrapVerify (verified) {
    return function wrappedVerified (err, user) {
      // if there is an error, it's neither an auth success nor a failure
      if (!err) {
        passportVerifyChannel.publish({ success: !!user, login: username, user })
      }

      return verified.apply(this, arguments)
    }
  })
}

function wrapVerify (verify) {
  return function wrappedVerify (req, username, password, verified) {
    if (passportVerifyChannel.hasSubscribers) {
      // verify can be called with or without req
      let verifiedIndex = 3
      if (!this._passReqToCallback) {
        verifiedIndex = 2
        username = req
        verified = password
      }

      // replace the callback with our own wrapper to get the result
      arguments[verifiedIndex] = wrapVerifiedAndPublish(username, verified)
      // if we ever need the type of strategy, we can get it from this.name
    }

    return verify.apply(this, arguments)
  }
}

function wrapStrategy (Strategy) {
  return function wrappedStrategy () {
    // verify function can be either the first or second argument
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0])
    } else {
      arguments[1] = wrapVerify(arguments[1])
    }

    return Strategy.apply(this, arguments)
  }
}

function strategyHook (Strategy) {
  return shimmer.wrapFunction(Strategy, wrapStrategy)
}

module.exports = {
  strategyHook
}
