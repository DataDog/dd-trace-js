'use strict'

const Limiter = require('../rate_limiter')
const { storage } = require('../../../datadog-core')
const web = require('../plugins/util/web')
const { ipHeaderList } = require('../plugins/util/ip_extractor')
const {
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,
  updateWafRequestsMetricTags,
  updateRaspRequestsMetricTags,
  updateRaspRuleSkippedMetricTags,
  updateRateLimitedMetric,
  getRequestMetrics
} = require('./telemetry')
const zlib = require('zlib')
const { keepTrace } = require('../priority_sampler')
const { ASM } = require('../standalone/product')

const REQUEST_HEADER_TAG_PREFIX = 'http.request.headers.'
const RESPONSE_HEADER_TAG_PREFIX = 'http.response.headers.'

const COLLECTED_REQUEST_BODY_MAX_STRING_LENGTH = 4096
const COLLECTED_REQUEST_BODY_MAX_DEPTH = 20
const COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE = 256

// default limiter, configurable with setRateLimit()
let limiter = new Limiter(100)

let extendedCollection = null

const metricsQueue = new Map()

// following header lists are ordered in the same way the spec orders them, it doesn't matter but it's easier to compare
const contentHeaderList = [
  'content-length',
  'content-type',
  'content-encoding',
  'content-language'
]

const EVENT_HEADERS_MAP = mapHeaderAndTags([
  ...ipHeaderList,
  'x-forwarded',
  'forwarded',
  'via',
  ...contentHeaderList,
  'host',
  'accept-encoding',
  'accept-language'
], REQUEST_HEADER_TAG_PREFIX)

const identificationHeaders = [
  'x-amzn-trace-id',
  'cloudfront-viewer-ja3-fingerprint',
  'cf-ray',
  'x-cloud-trace-context',
  'x-appgw-trace-id',
  'x-sigsci-requestid',
  'x-sigsci-tags',
  'akamai-user-risk'
]

// these request headers are always collected - it breaks the expected spec orders
const REQUEST_HEADERS_MAP = mapHeaderAndTags([
  'content-type',
  'user-agent',
  'accept',
  ...identificationHeaders
], REQUEST_HEADER_TAG_PREFIX)

const RESPONSE_HEADERS_MAP = mapHeaderAndTags(contentHeaderList, RESPONSE_HEADER_TAG_PREFIX)

function formatHeaderName (name) {
  return name
    .trim()
    .slice(0, 200)
    .replace(/[^a-zA-Z0-9_\-:/]/g, '_')
    .toLowerCase()
}

function getHeaderTag (tagPrefix, headerName) {
  return `${tagPrefix}${formatHeaderName(headerName)}`
}

function mapHeaderAndTags (headerList, tagPrefix) {
  return new Map(headerList.map(headerName => [headerName, getHeaderTag(tagPrefix, headerName)]))
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

function filterExtendedHeaders (headers, excludedHeaderNames, tagPrefix, limit = 0) {
  const result = {}

  if (!headers) return result

  let counter = 0
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (counter >= limit) break
    if (!excludedHeaderNames.includes(headerName)) {
      result[getHeaderTag(tagPrefix, headerName)] = '' + headerValue
      counter++
    }
  }

  return result
}

function getCollectedHeaders (req, res, shouldCollectEventHeaders) {
  // Mandatory
  const mandatoryCollectedHeaders = filterHeaders(req.headers, REQUEST_HEADERS_MAP)

  // Basic collection
  if (!shouldCollectEventHeaders) return mandatoryCollectedHeaders

  const requestEventCollectedHeaders = filterHeaders(req.headers, EVENT_HEADERS_MAP)
  const responseEventCollectedHeaders = filterHeaders(res.getHeaders(), RESPONSE_HEADERS_MAP)

  // Extended collection
  if (!(extendedCollection?.enabled && !extendedCollection?.redaction)) {
    return Object.assign(
      mandatoryCollectedHeaders,
      requestEventCollectedHeaders,
      responseEventCollectedHeaders
    )
  }

  const requestExtendedHeadersAvailableCount =
    extendedCollection.maxHeaders -
    Object.keys(mandatoryCollectedHeaders).length -
    Object.keys(requestEventCollectedHeaders).length

  const requestEventExtendedCollectedHeaders =
    filterExtendedHeaders(
      req.headers,
      [...REQUEST_HEADERS_MAP.keys()].concat([...EVENT_HEADERS_MAP.keys()]),
      REQUEST_HEADER_TAG_PREFIX,
      requestExtendedHeadersAvailableCount
    )

  const responseExtendedHeadersAvailableCount =
    extendedCollection.maxHeaders -
    Object.keys(responseEventCollectedHeaders).length

  const responseEventExtendedCollectedHeaders =
    filterExtendedHeaders(
      res.getHeaders(),
      [...RESPONSE_HEADERS_MAP.keys()],
      RESPONSE_HEADER_TAG_PREFIX,
      responseExtendedHeadersAvailableCount
    )

  const headersTags = Object.assign(
    mandatoryCollectedHeaders,
    requestEventCollectedHeaders,
    requestEventExtendedCollectedHeaders,
    responseEventCollectedHeaders,
    responseEventExtendedCollectedHeaders
  )

  // Check discarded headers
  const requestHeadersCount = Object.keys(req.headers).length
  if (requestHeadersCount > extendedCollection.maxHeaders) {
    headersTags['_dd.appsec.request.header_collection.discarded'] =
      requestHeadersCount - extendedCollection.maxHeaders
  }

  const responseHeadersCount = Object.keys(res.getHeaders()).length
  if (responseHeadersCount > extendedCollection.maxHeaders) {
    headersTags['_dd.appsec.response.header_collection.discarded'] =
      responseHeadersCount - extendedCollection.maxHeaders
  }

  return headersTags
}

function reportWafInit (wafVersion, rulesVersion, diagnosticsRules = {}, success = false) {
  if (success) {
    metricsQueue.set('_dd.appsec.waf.version', wafVersion)

    metricsQueue.set('_dd.appsec.event_rules.loaded', diagnosticsRules.loaded?.length || 0)
    metricsQueue.set('_dd.appsec.event_rules.error_count', diagnosticsRules.failed?.length || 0)
    if (diagnosticsRules.failed?.length) {
      metricsQueue.set('_dd.appsec.event_rules.errors', JSON.stringify(diagnosticsRules.errors))
    }
  }

  incrementWafInitMetric(wafVersion, rulesVersion, success)
}

function reportMetrics (metrics, raspRule) {
  const store = storage('legacy').getStore()
  const rootSpan = store?.req && web.root(store.req)

  if (!rootSpan) return

  if (metrics.rulesVersion) {
    rootSpan.setTag('_dd.appsec.event_rules.version', metrics.rulesVersion)
  }

  if (raspRule) {
    updateRaspRequestsMetricTags(metrics, store.req, raspRule)
  } else {
    updateWafRequestsMetricTags(metrics, store.req)
  }

  reportTruncationMetrics(rootSpan, metrics)
}

function reportTruncationMetrics (rootSpan, metrics) {
  if (metrics.maxTruncatedString) {
    rootSpan.setTag('_dd.appsec.truncated.string_length', metrics.maxTruncatedString)
  }

  if (metrics.maxTruncatedContainerSize) {
    rootSpan.setTag('_dd.appsec.truncated.container_size', metrics.maxTruncatedContainerSize)
  }

  if (metrics.maxTruncatedContainerDepth) {
    rootSpan.setTag('_dd.appsec.truncated.container_depth', metrics.maxTruncatedContainerDepth)
  }
}

function reportAttack (attackData) {
  const store = storage('legacy').getStore()
  const req = store?.req
  const rootSpan = web.root(req)
  if (!rootSpan) return

  const currentTags = rootSpan.context()._tags

  const newTags = {
    'appsec.event': 'true'
  }

  if (limiter.isAllowed()) {
    keepTrace(rootSpan, ASM)
  } else {
    updateRateLimitedMetric(req)
  }

  // TODO: maybe add this to format.js later (to take decision as late as possible)
  if (!currentTags['_dd.origin']) {
    newTags['_dd.origin'] = 'appsec'
  }

  const currentJson = currentTags['_dd.appsec.json']

  // merge JSON arrays without parsing them
  const attackDataStr = JSON.stringify(attackData)
  if (currentJson) {
    newTags['_dd.appsec.json'] = currentJson.slice(0, -2) + ',' + attackDataStr.slice(1) + '}'
  } else {
    newTags['_dd.appsec.json'] = '{"triggers":' + attackDataStr + '}'
  }

  if (req.socket) {
    newTags['network.client.ip'] = req.socket.remoteAddress
  }

  rootSpan.addTags(newTags)

  if (extendedCollection?.raspBodyCollection && isRaspAttack(attackData)) {
    reportRequestBody(rootSpan, req.body)
  }
}

function truncateRequestBody (target, depth = 0) {
  switch(typeof target) {
    case 'string':
      return target.slice(0, COLLECTED_REQUEST_BODY_MAX_STRING_LENGTH)
    case 'object':
      if (target === null) {
        return target
      }

      if (depth < COLLECTED_REQUEST_BODY_MAX_DEPTH) {
        if (Array.isArray(target)) {
          return target.slice(0, COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE)
            .map(v => truncateRequestBody(v, depth + 1))
        }

        const result = {}
        for (const key of Object.keys(target).slice(0, COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE)) {
          result[key] = truncateRequestBody(target[key], depth + 1)
        }
        return result
      }
      break
    default:
      return target
  }
}

function reportRequestBody (rootSpan, requestBody) {
  if (!requestBody) return

  if (!rootSpan.meta_struct) {
    rootSpan.meta_struct = {}
  }

  if (!rootSpan.meta_struct['http.request.body']) {
    // TODO truncate requestBody
    rootSpan.meta_struct['http.request.body'] = truncateRequestBody(requestBody)
  }
}

function isRaspAttack (events) {
  return events.some(e => e.rule?.tags?.module === 'rasp')
}

function isFingerprintDerivative (derivative) {
  return derivative.startsWith('_dd.appsec.fp')
}

function reportDerivatives (derivatives) {
  if (!derivatives) return

  const req = storage('legacy').getStore()?.req
  const rootSpan = web.root(req)

  if (!rootSpan) return

  const tags = {}
  for (let [tag, value] of Object.entries(derivatives)) {
    if (!isFingerprintDerivative(tag)) {
      const gzippedValue = zlib.gzipSync(JSON.stringify(value))
      value = gzippedValue.toString('base64')
    }
    tags[tag] = value
  }

  rootSpan.addTags(tags)
}

function finishRequest (req, res) {
  const rootSpan = web.root(req)
  if (!rootSpan) return

  if (metricsQueue.size) {
    rootSpan.addTags(Object.fromEntries(metricsQueue))

    keepTrace(rootSpan, ASM)

    metricsQueue.clear()
  }

  const metrics = getRequestMetrics(req)

  if (metrics?.duration) {
    rootSpan.setTag('_dd.appsec.waf.duration', metrics.duration)
  }

  if (metrics?.durationExt) {
    rootSpan.setTag('_dd.appsec.waf.duration_ext', metrics.durationExt)
  }

  if (metrics?.wafErrorCode) {
    rootSpan.setTag('_dd.appsec.waf.error', metrics.wafErrorCode)
  }

  if (metrics?.wafTimeouts) {
    rootSpan.setTag('_dd.appsec.waf.timeouts', metrics.wafTimeouts)
  }

  if (metrics?.raspDuration) {
    rootSpan.setTag('_dd.appsec.rasp.duration', metrics.raspDuration)
  }

  if (metrics?.raspDurationExt) {
    rootSpan.setTag('_dd.appsec.rasp.duration_ext', metrics.raspDurationExt)
  }

  if (metrics?.raspErrorCode) {
    rootSpan.setTag('_dd.appsec.rasp.error', metrics.raspErrorCode)
  }

  if (metrics?.raspTimeouts) {
    rootSpan.setTag('_dd.appsec.rasp.timeout', metrics.raspTimeouts)
  }

  if (metrics?.raspEvalCount) {
    rootSpan.setTag('_dd.appsec.rasp.rule.eval', metrics.raspEvalCount)
  }

  incrementWafRequestsMetric(req)

  const tags = rootSpan.context()._tags

  const newTags = getCollectedHeaders(req, res, shouldCollectEventHeaders(tags))

  if (tags['appsec.event'] === 'true' && typeof req.route?.path === 'string') {
    newTags['http.endpoint'] = req.route.path
  }

  rootSpan.addTags(newTags)
}

function shouldCollectEventHeaders (tags = {}) {
  if (tags['appsec.event'] === 'true') {
    return true
  }

  for (const tagName of Object.keys(tags)) {
    if (tagName.startsWith('appsec.events.')) {
      return true
    }
  }

  return false
}

function setRateLimit (rateLimit) {
  limiter = new Limiter(rateLimit)
}

function setExtendedCollection (extendedCollectionConfig) {
  extendedCollection = extendedCollectionConfig
}

module.exports = {
  metricsQueue,
  filterHeaders,
  filterExtendedHeaders,
  formatHeaderName,
  reportWafInit,
  reportMetrics,
  reportAttack,
  reportWafUpdate: incrementWafUpdatesMetric,
  reportRaspRuleSkipped: updateRaspRuleSkippedMetricTags,
  reportDerivatives,
  finishRequest,
  setRateLimit,
  mapHeaderAndTags,
  setExtendedCollection,
  truncateRequestBody
}
