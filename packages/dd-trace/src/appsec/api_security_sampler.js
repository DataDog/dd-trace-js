'use strict'

const ApiSecuritySamplerCache = require('./api_security_sampler_cache')
const PrioritySampler = require('../priority_sampler')
const web = require('../plugins/util/web')

let enabled
let sampledRequests
const prioritySampler = new PrioritySampler()

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

  const isSampled = prioritySampler.isSampled(rootSpan)

  if (!isSampled) {
    return false
  }

  const key = sampledRequests.computeKey(req, res)
  const alreadySampled = sampledRequests.isSampled(key)

  if (alreadySampled) return false

  sampledRequests.set(key)

  return true
}

module.exports = {
  configure,
  disable,
  sampleRequest
}
