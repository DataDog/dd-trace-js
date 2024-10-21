'use strict'

const TTLCache = require('@isaacs/ttlcache')
const web = require('../plugins/util/web')
const log = require('../log')
const { AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

const MAX_SIZE = 4096
const DEFAULT_DELAY = 30 // 30s

let enabled
let sampledRequests

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled
  const delay = apiSecurity.sampleDelay || DEFAULT_DELAY
  sampledRequests = new TTLCache({ max: MAX_SIZE, ttl: delay * 1000 })
}

function disable () {
  enabled = false
  sampledRequests?.clear()
}

function sampleRequest (req, res, force = false) {
  if (!enabled) return false
  if (isSampled(req, res)) return false

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
    return sample(req, res)
  }

  return true
}

function sample (req, res) {
  const key = computeKey(req, res)
  if (!key) return false
  if (sampledRequests.has(key)) return false

  sampledRequests.set(key)
  return true
}

function isSampled (req, res) {
  const key = computeKey(req, res)
  if (!key) return false

  return sampledRequests.has(key)
}

function computeKey (req, res) {
  const route = web.getContext(req)?.paths?.join('') || ''
  const method = req.method
  const status = res.statusCode

  if (!method || !status) {
    log.warn('Unsupported groupkey for API security')
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
  isSampled
}
