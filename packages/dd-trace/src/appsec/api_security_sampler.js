'use strict'

const TTLCache = require('@isaacs/ttlcache')
const web = require('../plugins/util/web')
const log = require('../log')
const { AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

const MAX_SIZE = 4096

let enabled
let sampledRequests

class NoopTTLCache {
  clear () { }
  set (key) { return undefined }
  has (key) { return false }
}

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled
  sampledRequests = apiSecurity.sampleDelay === 0
    ? new NoopTTLCache()
    : new TTLCache({ max: MAX_SIZE, ttl: apiSecurity.sampleDelay * 1000 })
}

function disable () {
  enabled = false
  sampledRequests?.clear()
}

function sampleRequest (req, res, force = false) {
  if (!enabled) return false

  const key = computeKey(req, res)
  if (!key || isSampled(key)) return false

  const rootSpan = web.root(req)
  if (!rootSpan) return false

  let priority = getSpanPriority(rootSpan)
  if (!priority) {
    rootSpan._prioritySampler?.sample(rootSpan)
    priority = getSpanPriority(rootSpan)
  }

  if (priority === AUTO_REJECT || priority === USER_REJECT) {
    return false
  }

  if (force) {
    sampledRequests.set(key)
  }

  return true
}

function isSampled (key) {
  return sampledRequests.has(key)
}

function computeKey (req, res) {
  const route = web.getContext(req)?.paths?.join('') || ''
  const method = req.method
  const status = res.statusCode

  if (!method || !status) {
    log.warn('[ASM] Unsupported groupkey for API security')
    return null
  }
  return method + route + status
}

function getSpanPriority (span) {
  const spanContext = span.context?.()
  return spanContext._sampling?.priority
}

module.exports = {
  configure,
  disable,
  sampleRequest,
  isSampled,
  computeKey
}
