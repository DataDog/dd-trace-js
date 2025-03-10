'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { tags, getVersionsTags, DD_TELEMETRY_REQUEST_METRICS } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')

const TRUNCATION_FLAGS = {
  LONG_STRING: 1,
  LARGE_CONTAINER: 2,
  DEEP_CONTAINER: 4
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

  const metricTags = getOrCreateMetricTags(store, versionsTags)

  if (metrics.blockFailed) {
    metricTags[tags.BLOCK_FAILURE] = true
  }

  if (metrics.blockTriggered) {
    metricTags[tags.REQUEST_BLOCKED] = true
  }

  if (metrics.errorCode) {
    metricTags[tags.WAF_ERROR] = true
  }

  if (metrics.rateLimited) {
    metricTags[tags.RATE_LIMITED] = true
  }

  if (metrics.ruleTriggered) {
    metricTags[tags.RULE_TRIGGERED] = true
  }

  const truncationReason = getTruncationReason(metrics)
  if (truncationReason > 0) {
    metricTags[tags.INPUT_TRUNCATED] = true
  }

  if (metrics.wafTimeout) {
    metricTags[tags.WAF_TIMEOUT] = true
  }

  return metricTags
}

function getOrCreateMetricTags (store, versionsTags) {
  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (!metricTags) {
    metricTags = {
      [tags.BLOCK_FAILURE]: false,
      [tags.INPUT_TRUNCATED]: false,
      [tags.REQUEST_BLOCKED]: false,
      [tags.RATE_LIMITED]: false,
      [tags.RULE_TRIGGERED]: false,
      [tags.WAF_ERROR]: false,
      [tags.WAF_TIMEOUT]: false,

      ...versionsTags
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

function getTruncationReason ({ maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth }) {
  let reason = 0

  if (maxTruncatedString) reason |= TRUNCATION_FLAGS.LONG_STRING
  if (maxTruncatedContainerSize) reason |= TRUNCATION_FLAGS.LARGE_CONTAINER
  if (maxTruncatedContainerDepth) reason |= TRUNCATION_FLAGS.DEEP_CONTAINER

  return reason
}

module.exports = {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafRequests
}
