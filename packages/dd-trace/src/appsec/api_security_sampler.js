'use strict'

const LRU = require('lru-cache')

let enabled
let sampledCache

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled

  if (enabled) {
    const {
      sampleCacheSize: max = 4096, // for testing purposes only
      sampleRate: ttl = 1000 * apiSecurity.sampleDelay
    } = apiSecurity

    sampledCache = new LRU({ max, ttl })
  }
}

function disable () {
  enabled = false
}

function sampleRequest (req, res) {
  if (!enabled) {
    return false
  }

  const key = getKey(req, res)
  const shouldSample = !sampledCache.has(key)
  if (shouldSample) {
    sampledCache.set(key)
  }

  return shouldSample
}

// rfc mentions using a hash
function getKey (req = {}, res = {}) {
  return `${req.method}-${req.url}-${res.statusCode}`
}

function has (req, res) {
  return sampledCache.has(getKey(req, res))
}

module.exports = {
  configure,
  disable,
  sampleRequest,
  has
}
