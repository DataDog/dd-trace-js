'use strict'

const crypto = require('node:crypto')
const LRUCache = require('lru-cache')
const PrioritySampler = require('../priority_sampler')
const web = require('../plugins/util/web')
const log = require('../log')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

const MAX_SIZE = 4096
const DEFAULT_DELAY = 30 // 30s

let enabled
let sampledRequests
let prioritySampler

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled
  const ttl = parseSampleDelay(apiSecurity.sampleDelay) * 1000
  sampledRequests = new LRUCache({ max: MAX_SIZE, ttl })
  prioritySampler = new PrioritySampler()
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

  if (priority === AUTO_REJECT || priority === USER_REJECT) {
    return false
  }

  if (priority === AUTO_KEEP || priority === USER_KEEP) {
    return sample(req, res)
  }

  const isSampled = prioritySampler.isSampled(rootSpan)

  if (!isSampled) {
    return false
  }

  return sample(req, res)
}

function sample (req, res) {
  const key = computeKey(req, res)
  const alreadySampled = sampledRequests.has(key)

  if (alreadySampled) return false

  sampledRequests.set(key)

  return true
}

function isSampled (req, res) {
  const key = computeKey(req, res)
  return !!sampledRequests.has(key)
}

function computeKey (req, res) {
  const route = req.route?.path || req.url
  const method = req.method.toLowerCase()
  const statusCode = res.statusCode
  const str = route + statusCode + method
  return crypto.createHash('md5').update(str).digest('hex')
}

function parseSampleDelay (delay) {
  if (typeof delay === 'number' && Number.isFinite(delay) && delay > 0) {
    return delay
  } else {
    log.warn('Invalid delay value. Delay must be a positive number.')
    return DEFAULT_DELAY
  }
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
