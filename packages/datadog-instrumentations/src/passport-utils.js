'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (framework, username, verified) {
  return shimmer.wrapFunction(verified, function wrapVerified (verified) {
    return function wrappedVerified (err, user) {
      // if there is an error, it's neither an auth success nor a failure
      if (!err) {
        const abortController = new AbortController()

        passportVerifyChannel.publish({ framework, login: username, user, success: !!user, abortController })

        if (abortController.signal.aborted) return
      }

      return verified.apply(this, arguments)
    }
  })
}

function wrapVerify (verify) {
  return function wrappedVerify (req, username, password, verified) {
    if (passportVerifyChannel.hasSubscribers) {
      const framework = `passport-${this.name}`

      // replace the callback with our own wrapper to get the result
      if (this._passReqToCallback) {
        arguments[3] = wrapVerifiedAndPublish(framework, arguments[1], arguments[3])
      } else {
        arguments[2] = wrapVerifiedAndPublish(framework, arguments[0], arguments[2])
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
