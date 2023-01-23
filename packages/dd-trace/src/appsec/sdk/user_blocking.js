'use strict'
const addresses = require('../addresses')
const Gateway = require('../gateway/engine')

function isUserBlocked (user) {
  const results = Gateway.propagate({ [addresses.USER_ID]: user.id })

  if (!results) {
    return false
  }

  for (const entry of results) {
    if (entry && entry.includes('block')) {
      return true
    }
  }

  return false
}

module.exports = {
  isUserBlocked
}
