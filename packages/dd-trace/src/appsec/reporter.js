'use strict'

const Limiter = require('../rate_limiter')
const { storage } = require('../../../datadog-core')
const web = require('../plugins/util/web')
const {
  incrementWafInitMetric,
  updateWafRequestsMetricTags,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric
} = require('./telemetry')

// default limiter, configurable with setRateLimit()
let limiter = new Limiter(100)

// TODO: use precomputed maps instead
const REQUEST_HEADERS_PASSLIST = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'forwarded',
  'forwarded-for',
  'host',
  'true-client-ip',
  'user-agent',
  'via',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded',
  'x-forwarded-for',
  'x-real-ip'
]

const RESPONSE_HEADERS_PASSLIST = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-type'
]

const metricsQueue = new Map()

function filterHeaders (headers, passlist, prefix) {
  const result = {}

  if (!headers) return result

  for (let i = 0; i < passlist.length; ++i) {
    const headerName = passlist[i]

    if (headers[headerName]) {
      result[`${prefix}${formatHeaderName(headerName)}`] = '' + headers[headerName]
    }
  }

  return result
}

// TODO: this can be precomputed at start time
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
  // TODO: metrics should be incremental, there already is an RFC to report metrics
  const store = storage.getStore()
  const rootSpan = store && store.req && web.root(store.req)
  if (!rootSpan) return

  if (metrics.duration) {
    rootSpan.setTag('_dd.appsec.waf.duration', metrics.duration)
  }

  if (metrics.durationExt) {
    rootSpan.setTag('_dd.appsec.waf.duration_ext', metrics.durationExt)
  }

  if (metrics.rulesVersion) {
    rootSpan.setTag('_dd.appsec.event_rules.version', metrics.rulesVersion)
  }

  updateWafRequestsMetricTags(metrics, store.req)
}

function reportAttack (attackData) {
  const store = storage.getStore()
  const req = store && store.req
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const currentTags = rootSpan.context()._tags

  const newTags = filterHeaders(req.headers, REQUEST_HEADERS_PASSLIST, 'http.request.headers.')

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

function finishRequest (req, res) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (metricsQueue.size) {
    rootSpan.addTags(Object.fromEntries(metricsQueue))

    metricsQueue.clear()
  }

  incrementWafRequestsMetric(req)

  if (!rootSpan.context()._tags['appsec.event']) return

  const newTags = filterHeaders(res.getHeaders(), RESPONSE_HEADERS_PASSLIST, 'http.response.headers.')

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
  finishRequest,
  setRateLimit
}
