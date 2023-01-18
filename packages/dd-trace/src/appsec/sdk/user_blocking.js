'use strict'
const addresses = require('../addresses')
const Gateway = require('../gateway/engine')

function isUserBlocked (tracer, user) {
  const span = tracer.scope().active()
  if (!span) {
    return false
  }

  const rootSpan = span._spanContext._trace.started[0]
  if (!rootSpan) {
    return false
  }

  const userId = rootSpan.context()._tags['usr.id']
  if (!user) {
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
