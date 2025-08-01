'use strict'

const dc = require('dc-polyfill')
const zlib = require('zlib')

const { storage } = require('../../../datadog-core')
const web = require('../plugins/util/web')
const { ipHeaderList } = require('../plugins/util/ip_extractor')
const {
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafConfigErrorsMetric,
  incrementWafRequestsMetric,
  updateWafRequestsMetricTags,
  updateRaspRequestsMetricTags,
  updateRaspRuleSkippedMetricTags,
  getRequestMetrics
} = require('./telemetry')
const { keepTrace } = require('../priority_sampler')
const { ASM } = require('../standalone/product')
const { DIAGNOSTIC_KEYS } = require('./waf/diagnostics')

const REQUEST_HEADER_TAG_PREFIX = 'http.request.headers.'
const RESPONSE_HEADER_TAG_PREFIX = 'http.response.headers.'

const COLLECTED_REQUEST_BODY_MAX_STRING_LENGTH = 4096
const COLLECTED_REQUEST_BODY_MAX_DEPTH = 20
const COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE = 256

const telemetryLogCh = dc.channel('datadog:telemetry:log')

const config = {
  headersExtendedCollectionEnabled: false,
  maxHeadersCollected: 0,
  headersRedaction: false,
  raspBodyCollection: false
}

const metricsQueue = new Map()

// following header lists are ordered in the same way the spec orders them, it doesn't matter but it's easier to compare
const contentHeaderList = [
  'content-length',
  'content-type',
  'content-encoding',
  'content-language'
]

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

const eventHeadersList = [
  ...ipHeaderList,
  'x-forwarded',
  'forwarded',
  'via',
  ...contentHeaderList,
  'host',
  'accept-encoding',
  'accept-language'
]

const requestHeadersList = [
  'content-type',
  'user-agent',
  'accept',
  ...identificationHeaders
]

// these request headers are always collected - it breaks the expected spec orders
const REQUEST_HEADERS_MAP = mapHeaderAndTags(requestHeadersList, REQUEST_HEADER_TAG_PREFIX)

const EVENT_HEADERS_MAP = mapHeaderAndTags(eventHeadersList, REQUEST_HEADER_TAG_PREFIX)

const RESPONSE_HEADERS_MAP = mapHeaderAndTags(contentHeaderList, RESPONSE_HEADER_TAG_PREFIX)

const NON_EXTENDED_REQUEST_HEADERS = new Set([...requestHeadersList, ...eventHeadersList])
const NON_EXTENDED_RESPONSE_HEADERS = new Set(contentHeaderList)

function init (_config) {
  config.headersExtendedCollectionEnabled = _config.extendedHeadersCollection.enabled
  config.maxHeadersCollected = _config.extendedHeadersCollection.maxHeaders
  config.headersRedaction = _config.extendedHeadersCollection.redaction
  config.raspBodyCollection = _config.rasp.bodyCollection
}

function formatHeaderName (name) {
  return name
    .trim()
    .slice(0, 200)
    .replaceAll(/[^a-zA-Z0-9_\-:/]/g, '_')
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
      result[tagName] = String(headerValue)
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
    if (!excludedHeaderNames.has(headerName)) {
      result[getHeaderTag(tagPrefix, headerName)] = String(headerValue)
      counter++
    }
  }

  return result
}

function getCollectedHeaders (req, res, shouldCollectEventHeaders, storedResponseHeaders = {}) {
  // Mandatory
  const mandatoryCollectedHeaders = filterHeaders(req.headers, REQUEST_HEADERS_MAP)

  // Basic collection
  if (!shouldCollectEventHeaders) return mandatoryCollectedHeaders

  const responseHeaders = Object.keys(storedResponseHeaders).length === 0
    ? res.getHeaders()
    : { ...storedResponseHeaders, ...res.getHeaders() }

  const requestEventCollectedHeaders = filterHeaders(req.headers, EVENT_HEADERS_MAP)
  const responseEventCollectedHeaders = filterHeaders(responseHeaders, RESPONSE_HEADERS_MAP)

  if (!config.headersExtendedCollectionEnabled || config.headersRedaction) {
    // Standard collection
    return Object.assign(
      mandatoryCollectedHeaders,
      requestEventCollectedHeaders,
      responseEventCollectedHeaders
    )
  }

  // Extended collection
  const requestExtendedHeadersAvailableCount =
    config.maxHeadersCollected -
    Object.keys(mandatoryCollectedHeaders).length -
    Object.keys(requestEventCollectedHeaders).length

  const requestEventExtendedCollectedHeaders =
    filterExtendedHeaders(
      req.headers,
      NON_EXTENDED_REQUEST_HEADERS,
      REQUEST_HEADER_TAG_PREFIX,
      requestExtendedHeadersAvailableCount
    )

  const responseExtendedHeadersAvailableCount =
    config.maxHeadersCollected -
    Object.keys(responseEventCollectedHeaders).length

  const responseEventExtendedCollectedHeaders =
    filterExtendedHeaders(
      responseHeaders,
      NON_EXTENDED_RESPONSE_HEADERS,
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
  if (requestHeadersCount > config.maxHeadersCollected) {
    headersTags['_dd.appsec.request.header_collection.discarded'] =
      requestHeadersCount - config.maxHeadersCollected
  }

  const responseHeadersCount = Object.keys(responseHeaders).length
  if (responseHeadersCount > config.maxHeadersCollected) {
    headersTags['_dd.appsec.response.header_collection.discarded'] =
      responseHeadersCount - config.maxHeadersCollected
  }

  return headersTags
}

function reportWafInit (wafVersion, rulesVersion, diagnosticsRules = {}, success = false) {
  if (success) {
    metricsQueue.set('_dd.appsec.waf.version', wafVersion)
  }

  incrementWafInitMetric(wafVersion, rulesVersion, success)
}

function logWafDiagnosticMessage (product, rcConfigId, configKey, message, level) {
  const tags =
    `log_type:rc::${product.toLowerCase()}::diagnostic,appsec_config_key:${configKey},rc_config_id:${rcConfigId}`
  telemetryLogCh.publish({
    message,
    level,
    tags
  })
}

function reportWafConfigUpdate (product, rcConfigId, diagnostics, wafVersion) {
  if (diagnostics.error) {
    logWafDiagnosticMessage(product, rcConfigId, '', diagnostics.error, 'ERROR')
    incrementWafConfigErrorsMetric(wafVersion, diagnostics.ruleset_version)
  }

  for (const configKey of DIAGNOSTIC_KEYS) {
    const configDiagnostics = diagnostics[configKey]
    if (!configDiagnostics) continue

    if (configDiagnostics.error) {
      logWafDiagnosticMessage(product, rcConfigId, configKey, configDiagnostics.error, 'ERROR')
      incrementWafConfigErrorsMetric(wafVersion, diagnostics.ruleset_version)
      continue
    }

    if (configDiagnostics.errors) {
      for (const [errorMessage, errorIds] of Object.entries(configDiagnostics.errors)) {
        logWafDiagnosticMessage(
          product,
          rcConfigId,
          configKey,
          `"${errorMessage}": ${JSON.stringify(errorIds)}`,
          'ERROR'
        )
        incrementWafConfigErrorsMetric(wafVersion, diagnostics.ruleset_version)
      }
    }

    if (configDiagnostics.warnings) {
      for (const [warningMessage, warningIds] of Object.entries(configDiagnostics.warnings)) {
        logWafDiagnosticMessage(
          product,
          rcConfigId,
          configKey,
          `"${warningMessage}": ${JSON.stringify(warningIds)}`,
          'WARN'
        )
      }
    }
  }
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

  // TODO: maybe add this to format.js later (to take decision as late as possible)
  if (!currentTags['_dd.origin']) {
    newTags['_dd.origin'] = 'appsec'
  }

  const currentJson = currentTags['_dd.appsec.json']

  // merge JSON arrays without parsing them
  const attackDataStr = JSON.stringify(attackData)
  newTags['_dd.appsec.json'] = currentJson
    ? currentJson.slice(0, -2) + ',' + attackDataStr.slice(1) + '}'
    : '{"triggers":' + attackDataStr + '}'

  if (req.socket) {
    newTags['network.client.ip'] = req.socket.remoteAddress
  }

  rootSpan.addTags(newTags)

  if (config.raspBodyCollection && isRaspAttack(attackData)) {
    reportRequestBody(rootSpan, req.body)
  }
}

function truncateRequestBody (target, depth = 0) {
  switch (typeof target) {
    case 'string':
      if (target.length > COLLECTED_REQUEST_BODY_MAX_STRING_LENGTH) {
        return { value: target.slice(0, COLLECTED_REQUEST_BODY_MAX_STRING_LENGTH), truncated: true }
      }
      return { value: target, truncated: false }
    case 'object': {
      if (target === null) {
        return { value: target, truncated: false }
      }

      if (depth >= COLLECTED_REQUEST_BODY_MAX_DEPTH) {
        return { truncated: true }
      }

      if (typeof target.toJSON === 'function') {
        try {
          return truncateRequestBody(target.toJSON(), depth + 1)
        } catch {
          return { truncated: false }
        }
      }

      if (Array.isArray(target)) {
        const maxArrayLength = Math.min(target.length, COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE)
        let wasTruncated = target.length > COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE
        const truncatedArray = new Array(maxArrayLength)
        for (let i = 0; i < maxArrayLength; i++) {
          const { value, truncated } = truncateRequestBody(target[i], depth + 1)
          if (truncated) wasTruncated = true
          truncatedArray[i] = value
        }

        return { value: truncatedArray, truncated: wasTruncated }
      }

      const keys = Object.keys(target)
      const maxKeysLength = Math.min(keys.length, COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE)
      let wasTruncated = keys.length > COLLECTED_REQUEST_BODY_MAX_ELEMENTS_PER_NODE

      const truncatedObject = {}
      for (let i = 0; i < maxKeysLength; i++) {
        const key = keys[i]
        const { value, truncated } = truncateRequestBody(target[key], depth + 1)
        if (truncated) wasTruncated = true
        truncatedObject[key] = value
      }
      return { value: truncatedObject, truncated: wasTruncated }
    }
    default:
      return { value: target, truncated: false }
  }
}

function reportRequestBody (rootSpan, requestBody) {
  if (!requestBody) return

  if (!rootSpan.meta_struct) {
    rootSpan.meta_struct = {}
  }

  if (!rootSpan.meta_struct['http.request.body']) {
    const { truncated, value } = truncateRequestBody(requestBody)
    rootSpan.meta_struct['http.request.body'] = value
    if (truncated) {
      rootSpan.setTag('_dd.appsec.rasp.request_body_size.exceeded', 'true')
    }
  }
}

function isRaspAttack (events) {
  return events.some(e => e.rule?.tags?.module === 'rasp')
}

function isSchemaAttribute (attribute) {
  return attribute.startsWith('_dd.appsec.s.')
}

function reportAttributes (attributes) {
  if (!attributes) return

  const req = storage('legacy').getStore()?.req
  const rootSpan = web.root(req)

  if (!rootSpan) return

  const tags = {}
  for (let [tag, value] of Object.entries(attributes)) {
    if (isSchemaAttribute(tag)) {
      const gzippedValue = zlib.gzipSync(JSON.stringify(value))
      value = gzippedValue.toString('base64')
    }
    tags[tag] = value
  }

  rootSpan.addTags(tags)
}

function finishRequest (req, res, storedResponseHeaders) {
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

  const newTags = getCollectedHeaders(req, res, shouldCollectEventHeaders(tags), storedResponseHeaders)

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

module.exports = {
  metricsQueue,
  init,
  filterHeaders,
  filterExtendedHeaders,
  formatHeaderName,
  reportWafInit,
  reportWafConfigUpdate,
  reportMetrics,
  reportAttack,
  reportWafUpdate: incrementWafUpdatesMetric,
  reportRaspRuleSkipped: updateRaspRuleSkippedMetricTags,
  reportAttributes,
  finishRequest,
  mapHeaderAndTags,
  truncateRequestBody
}
