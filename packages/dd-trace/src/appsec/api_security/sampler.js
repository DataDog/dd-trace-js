'use strict'

const { TTLCache } = require('../../../../../vendor/dist/@isaacs/ttlcache')
const web = require('../../plugins/util/web')
const log = require('../../log')
const { AUTO_REJECT, USER_REJECT } = require('../../../../../ext/priority')
const { keepTrace } = require('../../priority_sampler')
const { ASM } = require('../../standalone/product')
const { isBlocked } = require('../blocking')

const MAX_SIZE = 4096

const SamplingDecision = Object.freeze({
  SAMPLE: 'sample',
  MISSING_ROUTE: 'missing_route',
  SKIP: 'skip',
})

let enabled
let asmStandaloneEnabled

/**
 * @type {TTLCache}
 */
let sampledRequests

class NoopTTLCache {
  clear () {}
  set (_key, _value) {}
  has (_key) { return false }
}

function configure ({ appsec, apmTracingEnabled }) {
  enabled = appsec.apiSecurity.enabled
  asmStandaloneEnabled = apmTracingEnabled === false
  sampledRequests = appsec.apiSecurity.sampleDelay === 0
    ? new NoopTTLCache()
    : new TTLCache({ max: MAX_SIZE, ttl: appsec.apiSecurity.sampleDelay * 1000 })
}

function disable () {
  enabled = false
  sampledRequests?.clear()
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {boolean} record When true and the decision is SAMPLE, records the endpoint in the TTL cache
 * @returns {'sample' | 'missing_route' | 'skip'}
 */
function sampleRequest (req, res, record = false) {
  if (!enabled) return SamplingDecision.SKIP

  const rootSpan = web.root(req)
  if (!rootSpan) return SamplingDecision.SKIP

  if (asmStandaloneEnabled) {
    keepTrace(rootSpan, ASM)
  } else {
    let priority = getSpanPriority(rootSpan)
    if (!priority) {
      rootSpan._prioritySampler?.sample(rootSpan)
      priority = getSpanPriority(rootSpan)
    }

    if (priority === AUTO_REJECT || priority === USER_REJECT) {
      return SamplingDecision.SKIP
    }
  }

  const resolved = resolveSamplingKey(req, res)
  if (!resolved) return SamplingDecision.SKIP

  if (!resolved.route) {
    if (resolved.status === 404 || isBlocked(res)) return SamplingDecision.SKIP
    return SamplingDecision.MISSING_ROUTE
  }

  if (sampledRequests.has(resolved.key)) return SamplingDecision.SKIP

  if (record) {
    sampledRequests.set(resolved.key, undefined)
  }

  return SamplingDecision.SAMPLE
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} Whether this request's endpoint is currently recorded in the TTL cache.
 */
function wasSampled (req, res) {
  const resolved = resolveSamplingKey(req, res)
  return resolved !== null && sampledRequests.has(resolved.key)
}

function resolveSamplingKey (req, res) {
  const method = req.method
  const status = res.statusCode

  if (!method || !status) {
    log.warn('[ASM] Unsupported groupkey for API security')
    return null
  }

  const context = web.getContext(req)
  const route = getRouteOrEndpoint(context, status)

  return { method, status, route, key: method + route + status }
}

function getRouteOrEndpoint (context, statusCode) {
  // First try to get the route from the context paths
  const route = context?.paths?.join('') || ''
  if (route) {
    return route
  }

  // If route is not available, fallback to http.endpoint
  if (statusCode !== 404) {
    const endpoint = context?.span?.context()?.getTag('http.endpoint')
    if (endpoint) {
      return endpoint
    }
  }

  return ''
}

function getSpanPriority (span) {
  const spanContext = span.context?.()
  return spanContext._sampling?.priority
}

module.exports = {
  configure,
  disable,
  sampleRequest,
  wasSampled,
  SamplingDecision,
}
