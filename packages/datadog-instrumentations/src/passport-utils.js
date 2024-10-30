'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, verified) {
  return shimmer.wrapFunction(verified, function wrapVerify (verified) {
    return function wrappedVerified (err, user) {
      // if there is an error, it's neither an auth success nor a failure
      if (!err) {
        passportVerifyChannel.publish({ login: username, user, success: !!user })
      }

      return verified.apply(this, arguments)
    }
  })
}

function wrapVerify (verify) {
  return function wrappedVerify (req, username, password, verified) {
    if (passportVerifyChannel.hasSubscribers) {
      // replace the callback with our own wrapper to get the result
      // if we ever need the type of strategy, we can get it from this.name
      if (this._passReqToCallback) {
        arguments[3] = wrapVerifiedAndPublish(username, verified)
      } else {
        arguments[2] = wrapVerifiedAndPublish(req, password) // shifted args
      }
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
