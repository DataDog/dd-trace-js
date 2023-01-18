'use strict'
const addresses = require('../addresses')
const Gateway = require('../gateway/engine')
const { getRootSpan } = require('./utils')

function isUserBlocked (tracer, user) {
  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    return false
  }

  const userId = rootSpan.context()._tags['usr.id']
  if (!userId) {
    tracer.appsec.setUser({ id: userId }, rootSpan)
  }

  const results = Gateway.propagate({ [addresses.USER_ID]: user.id }, context)

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
