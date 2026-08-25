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
  enabled = appsec.DD_API_SECURITY_ENABLED
  asmStandaloneEnabled = apmTracingEnabled === false
  sampledRequests = appsec.DD_API_SECURITY_SAMPLE_DELAY === 0
    ? new NoopTTLCache()
    : new TTLCache({ max: MAX_SIZE, ttl: appsec.DD_API_SECURITY_SAMPLE_DELAY * 1000 })
}

function disable () {
  enabled = false
  sampledRequests?.clear()
}

/**
 * @param {object} rootSpan Span the sampling decision is attached to
 * @param {object} request
 * @param {string} request.method
 * @param {number|string} request.statusCode
 * @param {string|null} request.route Tri-state: a route string, an empty string (still a valid
 *   route — dd-trace-js represents the express root path '/' as an empty path segment), or
 *   `null` meaning no route information at all.
 * @param {boolean} [request.blocked] Whether the response was blocked by ASM
 * @param {boolean} record When true and the decision is SAMPLE, records the endpoint in the TTL cache
 * @returns {'sample' | 'missing_route' | 'skip'}
 */
function sampleRootSpanRequest (rootSpan, { method, statusCode, route, blocked = false }, record = false) {
  if (!enabled) return SamplingDecision.SKIP

  if (!rootSpan) return SamplingDecision.SKIP

  if (isRejected(rootSpan)) return SamplingDecision.SKIP

  if (!method || !statusCode) {
    log.warn('[ASM] Unsupported groupkey for API security')
    return SamplingDecision.SKIP
  }

  if (record && route === null) {
    if (Number(statusCode) === 404 || blocked) return SamplingDecision.SKIP
    return SamplingDecision.MISSING_ROUTE
  }

  const key = buildSamplingKey(method, route, statusCode)
  if (sampledRequests.has(key)) return SamplingDecision.SKIP

  if (asmStandaloneEnabled) {
    keepTrace(rootSpan, ASM)
  }

  if (record) {
    sampledRequests.set(key, undefined)
  }

  return SamplingDecision.SAMPLE
}

/**
 * Node HTTP adapter over {@link sampleRootSpanRequest}.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {boolean} record When true and the decision is SAMPLE, records the endpoint in the TTL cache
 * @returns {'sample' | 'missing_route' | 'skip'}
 */
function sampleRequest (req, res, record = false) {
  if (!enabled) return SamplingDecision.SKIP

  const rootSpan = web.root(req)
  if (!rootSpan) return SamplingDecision.SKIP

  if (isRejected(rootSpan)) return SamplingDecision.SKIP

  const statusCode = res.statusCode
  const route = getRouteOrEndpoint(web.getContext(req), statusCode)

  return sampleRootSpanRequest(rootSpan, {
    method: req.method,
    statusCode,
    route,
    blocked: record && route === null ? isBlocked(res) : false,
  }, record)
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

function buildSamplingKey (method, route, statusCode) {
  return method + (route ?? '') + statusCode
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

  // route === null signals "no route information at all". An empty string is still a valid
  // route (dd-trace-js represents the express root path '/' as an empty path segment).
  return { method, status, route, key: buildSamplingKey(method, route, status) }
}

function getRouteOrEndpoint (context, statusCode) {
  // The router plugin populates `context.paths` whenever the framework matched something.
  // For express's root '/' route the matched path is normalized to '' (see datadog-plugin-router),
  // so `paths.length > 0` is the signal that the framework provided route information — even when
  // the joined string is empty. An empty `paths` array means no router involvement at all.
  const paths = context?.paths
  if (paths !== undefined && paths.length > 0) {
    return paths.join('')
  }

  if (statusCode === 404) return null

  const endpoint = context?.span?.context()?.getTag?.('http.endpoint')
  if (endpoint) return endpoint

  return null
}

/**
 * Whether the span's trace is dropped, forcing the sampling decision if none was made yet.
 *
 * Always false under ASM standalone: there the trace is kept via `keepTrace(rootSpan, ASM)`
 * regardless of the APM sampling decision.
 *
 * @param {object} rootSpan
 * @returns {boolean}
 */
function isRejected (rootSpan) {
  if (asmStandaloneEnabled) return false

  let priority = getSpanPriority(rootSpan)
  if (!priority) {
    rootSpan._prioritySampler?.sample(rootSpan)
    priority = getSpanPriority(rootSpan)
  }

  return priority === AUTO_REJECT || priority === USER_REJECT
}

function getSpanPriority (span) {
  const spanContext = span.context?.()
  const priority = spanContext._sampling?.priority

  return priority == null ? priority : Number(priority)
}

module.exports = {
  configure,
  disable,
  sampleRequest,
  sampleRootSpanRequest,
  wasSampled,
  SamplingDecision,
}
