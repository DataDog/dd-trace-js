'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { tags, getVersionsTags } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')
const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

const TRUNCATION_FLAGS = {
  LONG_STRING: 1,
  LARGE_CONTAINER: 2,
  DEEP_CONTAINER: 4
}

function addWafRequestMetrics (store, metrics) {
  const { duration, durationExt, wafTimeout, errorCode } = metrics

  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafTimeouts++
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

function trackWafDurations (metrics, versionsTags) {
  if (metrics.duration) {
    appsecMetrics.distribution('waf.duration', versionsTags).track(metrics.duration)
  }

  if (metrics.durationExt) {
    appsecMetrics.distribution('waf.duration_ext', versionsTags).track(metrics.durationExt)
  }
}

function trackWafMetrics (store, metrics) {
  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  trackWafDurations(metrics, versionsTags)

  const metricTags = getOrCreateMetricTags(store, versionsTags)

  const { blockTriggered, ruleTriggered, wafTimeout } = metrics

  if (blockTriggered) {
    metricTags[tags.REQUEST_BLOCKED] = true
  }

  if (ruleTriggered) {
    metricTags[tags.RULE_TRIGGERED] = true
  }

  if (wafTimeout) {
    metricTags[tags.WAF_TIMEOUT] = true
  }

  if (metrics.errorCode) {
    const errorTags = { ...versionsTags, waf_error: metrics.errorCode }

    appsecMetrics.count('waf.error', errorTags).inc(1)
    metricTags[tags.WAF_ERROR] = true
  }

  incrementTruncatedMetrics(metrics)
}

function incrementTruncatedMetrics (metrics) {
  const truncationReason = getTruncationReason(metrics)

  if (truncationReason > 0) {
    const truncationTags = { truncation_reason: truncationReason }
    appsecMetrics.count('appsec.waf.input_truncated', truncationTags).inc(1)
  }

  if (metrics?.maxTruncatedString) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size',
      { truncation_reason: TRUNCATION_FLAGS.LONG_STRING })
      .track(metrics.maxTruncatedString)
  }

  if (metrics?.maxTruncatedContainerSize) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size',
      { truncation_reason: TRUNCATION_FLAGS.LARGE_CONTAINER })
      .track(metrics.maxTruncatedContainerSize)
  }

  if (metrics?.maxTruncatedContainerDepth) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size',
      { truncation_reason: TRUNCATION_FLAGS.DEEP_CONTAINER })
      .track(metrics.maxTruncatedContainerDepth)
  }
}

function getTruncationReason ({ maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth }) {
  let reason = 0

  if (maxTruncatedString) reason |= TRUNCATION_FLAGS.LONG_STRING
  if (maxTruncatedContainerSize) reason |= TRUNCATION_FLAGS.LARGE_CONTAINER
  if (maxTruncatedContainerDepth) reason |= TRUNCATION_FLAGS.DEEP_CONTAINER

  return reason
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
