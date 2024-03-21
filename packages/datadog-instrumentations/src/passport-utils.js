'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const passportVerifyChannel = channel('datadog:passport:verify:finish')

function wrapVerifiedAndPublish (username, password, verified, type) {
  if (!passportVerifyChannel.hasSubscribers) {
    return verified
  }

  // eslint-disable-next-line n/handle-callback-err
  return shimmer.wrap(verified, function (err, user, info) {
    const credentials = { type, username }
    passportVerifyChannel.publish({ credentials, user })
    return verified.apply(this, arguments)
  })
}

function wrapVerify (verify, passReq, type) {
  if (passReq) {
    return function (req, username, password, verified) {
      arguments[3] = wrapVerifiedAndPublish(username, password, verified, type)
      return verify.apply(this, arguments)
    }
  } else {
    return function (username, password, verified) {
      arguments[2] = wrapVerifiedAndPublish(username, password, verified, type)
      return verify.apply(this, arguments)
    }
  }
}

module.exports = {
  wrapVerify
}
