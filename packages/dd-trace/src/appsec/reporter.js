'use strict'

const Limiter = require('../rate_limiter')
const { storage } = require('../../../datadog-core')
const web = require('../plugins/util/web')
const { ipHeaderList } = require('../plugins/util/ip_extractor')
const {
  incrementWafInitMetric,
  updateWafRequestsMetricTags,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,
  getRequestMetrics
} = require('./telemetry')
const zlib = require('zlib')

// default limiter, configurable with setRateLimit()
let limiter = new Limiter(100)

const metricsQueue = new Map()

// following header lists are ordered in the same way the spec orders them, it doesn't matter but it's easier to compare
const contentHeaderList = [
  'content-length',
  'content-type',
  'content-encoding',
  'content-language'
]

const REQUEST_HEADERS_MAP = mapHeaderAndTags([
  ...ipHeaderList,
  'forwarded',
  'via',
  ...contentHeaderList,
  'host',
  'user-agent',
  'accept',
  'accept-encoding',
  'accept-language'
], 'http.request.headers.')

const IDENTIFICATION_HEADERS_MAP = mapHeaderAndTags([
  'x-amzn-trace-id',
  'cloudfront-viewer-ja3-fingerprint',
  'cf-ray',
  'x-cloud-trace-context',
  'x-appgw-trace-id',
  'x-sigsci-requestid',
  'x-sigsci-tags',
  'akamai-user-risk'
], 'http.request.headers.')

const RESPONSE_HEADERS_MAP = mapHeaderAndTags(contentHeaderList, 'http.response.headers.')

function mapHeaderAndTags (headerList, tagPrefix) {
  return new Map(headerList.map(headerName => [headerName, `${tagPrefix}${formatHeaderName(headerName)}`]))
}

function filterHeaders (headers, map) {
  const result = {}

  if (!headers) return result

  for (const [headerName, tagName] of map) {
    const headerValue = headers[headerName]
    if (headerValue) {
      result[tagName] = '' + headerValue
    }
  }

  return result
}

function formatHeaderName (name) {
  return name
    .trim()
    .slice(0, 200)
    .replace(/[^a-zA-Z0-9_\-:/]/g, '_')
    .toLowerCase()
}

function reportWafInit (wafVersion, rulesVersion, diagnosticsRules = {}) {
  metricsQueue.set('_dd.appsec.waf.version', wafVersion)

  metricsQueue.set('_dd.appsec.event_rules.loaded', diagnosticsRules.loaded?.length || 0)
  metricsQueue.set('_dd.appsec.event_rules.error_count', diagnosticsRules.failed?.length || 0)
  if (diagnosticsRules.failed?.length) {
    metricsQueue.set('_dd.appsec.event_rules.errors', JSON.stringify(diagnosticsRules.errors))
  }

  metricsQueue.set('manual.keep', 'true')

  incrementWafInitMetric(wafVersion, rulesVersion)
}

function reportMetrics (metrics) {
  const store = storage.getStore()
  const rootSpan = store?.req && web.root(store.req)
  if (!rootSpan) return

  if (metrics.rulesVersion) {
    rootSpan.setTag('_dd.appsec.event_rules.version', metrics.rulesVersion)
  }

  updateWafRequestsMetricTags(metrics, store.req)
}

function reportAttack (attackData) {
  const store = storage.getStore()
  const req = store?.req
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const currentTags = rootSpan.context()._tags

  const newTags = filterHeaders(req.headers, REQUEST_HEADERS_MAP)

  newTags['appsec.event'] = 'true'

  if (limiter.isAllowed()) {
    newTags['manual.keep'] = 'true' // TODO: figure out how to keep appsec traces with sampling revamp
  }

  // TODO: maybe add this to format.js later (to take decision as late as possible)
  if (!currentTags['_dd.origin']) {
    newTags['_dd.origin'] = 'appsec'
  }

  const currentJson = currentTags['_dd.appsec.json']

  // merge JSON arrays without parsing them
  if (currentJson) {
    newTags['_dd.appsec.json'] = currentJson.slice(0, -2) + ',' + attackData.slice(1) + '}'
  } else {
    newTags['_dd.appsec.json'] = '{"triggers":' + attackData + '}'
  }

  const ua = newTags['http.request.headers.user-agent']
  if (ua) {
    newTags['http.useragent'] = ua
  }

  newTags['network.client.ip'] = req.socket.remoteAddress

  rootSpan.addTags(newTags)
}

function reportSchemas (derivatives) {
  if (!derivatives) return

  const req = storage.getStore()?.req
  const rootSpan = web.root(req)

  if (!rootSpan) return

  const tags = {}
  for (const [address, value] of Object.entries(derivatives)) {
    const gzippedValue = zlib.gzipSync(JSON.stringify(value))
    tags[address] = gzippedValue.toString('base64')
  }

  rootSpan.addTags(tags)
}

function finishRequest (req, res) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (metricsQueue.size) {
    rootSpan.addTags(Object.fromEntries(metricsQueue))

    metricsQueue.clear()
  }

  const metrics = getRequestMetrics(req)
  if (metrics?.duration) {
    rootSpan.setTag('_dd.appsec.waf.duration', metrics.duration)
  }

  if (metrics?.durationExt) {
    rootSpan.setTag('_dd.appsec.waf.duration_ext', metrics.durationExt)
  }

  incrementWafRequestsMetric(req)

  // collect some headers even when no attack is detected
  rootSpan.addTags(filterHeaders(req.headers, IDENTIFICATION_HEADERS_MAP))

  if (!rootSpan.context()._tags['appsec.event']) return

  const newTags = filterHeaders(res.getHeaders(), RESPONSE_HEADERS_MAP)

  if (req.route && typeof req.route.path === 'string') {
    newTags['http.endpoint'] = req.route.path
  }

  rootSpan.addTags(newTags)
}

function setRateLimit (rateLimit) {
  limiter = new Limiter(rateLimit)
}

module.exports = {
  metricsQueue,
  filterHeaders,
  formatHeaderName,
  reportWafInit,
  reportMetrics,
  reportAttack,
  reportWafUpdate: incrementWafUpdatesMetric,
  reportSchemas,
  finishRequest,
  setRateLimit,
  mapHeaderAndTags
}
