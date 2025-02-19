'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { tags, getVersionsTags } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')
const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

function addWafRequestMetrics (store, metrics) {
  const { duration, durationExt, wafTimeout, errorCode } = metrics

  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafTimeout++
  }

  if (errorCode) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode = Math.max(
      errorCode,
      store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode ?? errorCode
    )
  }

  if (getTruncationReason(metrics) > 0) {
    store[DD_TELEMETRY_REQUEST_METRICS].input_truncated = true
  }
}

function getTruncationReason ({ maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth }) {
  let reason = 0

  if (maxTruncatedString) reason |= 1 // string too long
  if (maxTruncatedContainerSize) reason |= 2 // list/map too large
  if (maxTruncatedContainerDepth) reason |= 4 // object too deep

  return reason
}

function trackWafDurations (metrics, versionsTags) {
  if (metrics.duration) {
    appsecMetrics.distribution('waf.duration', versionsTags).track(metrics.duration)
  }

  if (metrics.durationExt) {
    appsecMetrics.distribution('waf.duration_ext', versionsTags).track(metrics.durationExt)
  }

  if (metrics.wafTimeouts) {
    appsecMetrics.distribution('waf.timeouts', versionsTags).track(metrics.wafTimeouts)
  }
}

function trackWafMetrics (store, metrics) {
  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  trackWafDurations(metrics, versionsTags)

  const metricTags = getOrCreateMetricTags(store, versionsTags)

  const { blockTriggered, ruleTriggered, wafTimeout } = metrics

  if (blockTriggered) {
    metricTags[tags.REQUEST_BLOCKED] = blockTriggered
  }

  if (ruleTriggered) {
    metricTags[tags.RULE_TRIGGERED] = ruleTriggered
  }

  if (wafTimeout) {
    metricTags[tags.WAF_TIMEOUT] = wafTimeout
  }

  if (metrics.errorCode) {
    const errorTags = { ...versionsTags, waf_error: metrics.errorCode }

    appsecMetrics.count('waf.error', errorTags).inc(1)
    metricTags[tags.WAF_ERROR] = true
  }
}

function getOrCreateMetricTags (store, versionsTags) {
  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (!metricTags) {
    metricTags = {
      [tags.BLOCK_FAILURE]: false,
      [tags.REQUEST_BLOCKED]: false,
      [tags.INPUT_TRUNCATED]: false,
      [tags.RULE_TRIGGERED]: false,
      [tags.WAF_TIMEOUT]: false,
      [tags.WAF_ERROR]: false,

      ...versionsTags
    }
    store[DD_TELEMETRY_WAF_RESULT_TAGS] = metricTags
  }
  return metricTags
}

function incrementWafInit (wafVersion, rulesVersion, success) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  const initTags = { ...versionsTags, success }

  appsecMetrics.count('waf.init', initTags).inc()
}

function incrementWafUpdates (wafVersion, rulesVersion, success) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  const updateTags = { ...versionsTags, success }

  appsecMetrics.count('waf.updates', updateTags).inc()
}

function incrementWafRequests (store) {
  const metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (metricTags) {
    appsecMetrics.count('waf.requests', metricTags).inc()
  }
}

module.exports = {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafRequests
}
