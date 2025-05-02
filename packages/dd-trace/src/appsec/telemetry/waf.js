'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { tags, getVersionsTags, DD_TELEMETRY_REQUEST_METRICS } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')

const TRUNCATION_FLAGS = {
  STRING: 1,
  CONTAINER_SIZE: 2,
  CONTAINER_DEPTH: 4
}

function addWafRequestMetrics (store, { duration, durationExt, wafTimeout, errorCode }) {
  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafTimeouts++
  }

  if (errorCode) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode = store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode
      ? Math.max(
        errorCode,
        store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode
      )
      : errorCode
  }
}

function trackWafMetrics (store, metrics) {
  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  const metricTags = getOrCreateMetricTags(store, versionsTags)

  if (metrics.blockFailed) {
    metricTags[tags.BLOCK_FAILURE] = true
  }

  if (metrics.blockTriggered) {
    metricTags[tags.REQUEST_BLOCKED] = true
  }

  if (metrics.rateLimited) {
    metricTags[tags.RATE_LIMITED] = true
  }

  if (metrics.ruleTriggered) {
    metricTags[tags.RULE_TRIGGERED] = true
  }

  if (metrics.errorCode) {
    metricTags[tags.WAF_ERROR] = true
    appsecMetrics.count('waf.error', { ...versionsTags, waf_error: metrics.errorCode }).inc()
  }

  if (metrics.wafTimeout) {
    metricTags[tags.WAF_TIMEOUT] = true
  }

  const truncationReason = getTruncationReason(metrics)
  if (truncationReason > 0) {
    metricTags[tags.INPUT_TRUNCATED] = true
    incrementTruncatedMetrics(metrics, truncationReason)
  }

  return metricTags
}

function getOrCreateMetricTags (store, versionsTags) {
  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (!metricTags) {
    metricTags = {
      [tags.BLOCK_FAILURE]: false,
      [tags.INPUT_TRUNCATED]: false,
      [tags.RATE_LIMITED]: false,
      [tags.REQUEST_BLOCKED]: false,
      [tags.RULE_TRIGGERED]: false,
      [tags.WAF_ERROR]: false,
      [tags.WAF_TIMEOUT]: false,

      ...versionsTags
    }
    store[DD_TELEMETRY_WAF_RESULT_TAGS] = metricTags
  }

  return metricTags
}

function incrementWafInit (wafVersion, rulesVersion, success) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  appsecMetrics.count('waf.init', { ...versionsTags, success }).inc()

  if (!success) {
    appsecMetrics.count('waf.config_errors', versionsTags).inc()
  }
}

function incrementWafUpdates (wafVersion, rulesVersion, success) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  appsecMetrics.count('waf.updates', { ...versionsTags, success }).inc()
}

function incrementWafConfigErrors (wafVersion, rulesVersion) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  appsecMetrics.count('waf.config_errors', versionsTags).inc()
}

function incrementWafRequests (store) {
  const metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (metricTags) {
    appsecMetrics.count('waf.requests', metricTags).inc()
  }
}

function incrementTruncatedMetrics (metrics, truncationReason) {
  const truncationTags = { truncation_reason: truncationReason }
  appsecMetrics.count('waf.input_truncated', truncationTags).inc(1)
}

function getTruncationReason ({ maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth }) {
  let reason = 0

  if (maxTruncatedString) reason |= TRUNCATION_FLAGS.STRING
  if (maxTruncatedContainerSize) reason |= TRUNCATION_FLAGS.CONTAINER_SIZE
  if (maxTruncatedContainerDepth) reason |= TRUNCATION_FLAGS.CONTAINER_DEPTH

  return reason
}

module.exports = {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafConfigErrors,
  incrementWafRequests
}
