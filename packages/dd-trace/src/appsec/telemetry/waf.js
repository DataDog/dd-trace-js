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
    if (store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode) {
      store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode = Math.max(
        errorCode,
        store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode
      )
    } else {
      store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode = errorCode
    }
  }
}

function trackWafDurations ({ duration, durationExt }, versionsTags) {
  if (duration) {
    appsecMetrics.distribution('waf.duration', versionsTags).track(duration)
  }

  if (durationExt) {
    appsecMetrics.distribution('waf.duration_ext', versionsTags).track(durationExt)
  }
}

function trackWafMetrics (store, metrics) {
  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  trackWafDurations(metrics, versionsTags)

  const metricTags = getOrCreateMetricTags(store)

  if (metrics.blockFailed) {
    metricTags[tags.BLOCK_FAILURE] = true
  }

  if (versionsTags[tags.EVENT_RULES_VERSION]) {
    metricTags[tags.EVENT_RULES_VERSION] = versionsTags[tags.EVENT_RULES_VERSION]
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
  }

  if (metrics.wafTimeout) {
    metricTags[tags.WAF_TIMEOUT] = true
  }

  if (versionsTags[tags.WAF_VERSION]) {
    metricTags[tags.WAF_VERSION] = versionsTags[tags.WAF_VERSION]
  }

  const truncationReason = getTruncationReason(metrics)
  if (truncationReason > 0) {
    metricTags[tags.INPUT_TRUNCATED] = true
    incrementTruncatedMetrics(metrics, truncationReason)
  }

  return metricTags
}

function getOrCreateMetricTags (store) {
  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (!metricTags) {
    metricTags = {
      [tags.BLOCK_FAILURE]: false,
      [tags.EVENT_RULES_VERSION]: null,
      [tags.INPUT_TRUNCATED]: false,
      [tags.RATE_LIMITED]: false,
      [tags.REQUEST_BLOCKED]: false,
      [tags.RULE_TRIGGERED]: false,
      [tags.WAF_ERROR]: false,
      [tags.WAF_TIMEOUT]: false,
      [tags.WAF_VERSION]: null
    }
    store[DD_TELEMETRY_WAF_RESULT_TAGS] = metricTags
  }

  return metricTags
}

function incrementWafInit (wafVersion, rulesVersion) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  appsecMetrics.count('waf.init', versionsTags).inc()
}

function incrementWafUpdates (wafVersion, rulesVersion) {
  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  appsecMetrics.count('waf.updates', versionsTags).inc()
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

  if (metrics?.maxTruncatedString) {
    appsecMetrics.distribution('waf.truncated_value_size', {
      truncation_reason: TRUNCATION_FLAGS.STRING
    }).track(metrics.maxTruncatedString)
  }

  if (metrics?.maxTruncatedContainerSize) {
    appsecMetrics.distribution('waf.truncated_value_size', {
      truncation_reason: TRUNCATION_FLAGS.CONTAINER_SIZE
    }).track(metrics.maxTruncatedContainerSize)
  }

  if (metrics?.maxTruncatedContainerDepth) {
    appsecMetrics.distribution('waf.truncated_value_size', {
      truncation_reason: TRUNCATION_FLAGS.CONTAINER_DEPTH
    }).track(metrics.maxTruncatedContainerDepth)
  }
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
  incrementWafRequests
}
