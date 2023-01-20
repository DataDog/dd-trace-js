'use strict'
const addresses = require('../addresses')
const Gateway = require('../gateway/engine')
const { getRootSpan } = require('./utils')

function isUserBlocked (user) {
  const results = Gateway.propagate({ [addresses.USER_ID]: user.id })

  if (!results) {
    return false
  }

  for (const entry in results) {
    if (entry && entry.includes('block')) {
      return true
    }
  }

  return false
}

module.exports = {
  isUserBlocked
}
