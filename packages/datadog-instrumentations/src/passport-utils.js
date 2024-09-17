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

function wrapVerify (verify) {
  return function wrappedVerify (req, username, password, verified) {
    let index = 3

    if (!this._passReqToCallback) {
      index = 2
      username = req
      password = username
      verified = password
    }

    arguments[index] = wrapVerifiedAndPublish(username, password, verified, this.name)

    return verify.apply(this, arguments)
  }
}

function wrapStrategy (Strategy) {
  return function wrappedStrategy () {
    if (typeof arguments[0] === 'function') {
      arguments[0] = wrapVerify(arguments[0])
    } else {
      arguments[1] = wrapVerify(arguments[1])
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
