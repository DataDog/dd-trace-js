'use strict'

const ApiSecuritySamplerCache = require('./api_security_sampler_cache')
const web = require('../plugins/util/web')
const { USER_KEEP, AUTO_KEEP } = require('../../../../ext/priority')

let enabled
let sampledRequests

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled
  sampledRequests = new ApiSecuritySamplerCache(apiSecurity.sampleDelay)
}

function disable () {
  enabled = false
  sampledRequests?.clear()
}

function sampleRequest (req, res) {
  if (!enabled) return false

  const rootSpan = web.root(req)
  if (!rootSpan) return false

  const priority = getSpanPriority(rootSpan)

  if (priority !== AUTO_KEEP && priority !== USER_KEEP) {
    return false
  }

  const key = sampledRequests.computeKey(req, res)
  const isSampled = sampledRequests.isSampled(key)

  if (isSampled) return false

  sampledRequests.set(key)

  return true
}

function getSpanPriority (span) {
  const spanContext = span.context?.()
  return spanContext._sampling?.priority // default ??
}

module.exports = {
  configure,
  disable,
  sampleRequest
}
