'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { tags, getVersionsTags, DD_TELEMETRY_REQUEST_METRICS } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')

function addWafRequestMetrics (store, { duration, durationExt }) {
  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0
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

  return metricTags
}

function getOrCreateMetricTags (store, versionsTags) {
  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]

  if (!metricTags) {
    metricTags = {
      [tags.REQUEST_BLOCKED]: false,
      [tags.RULE_TRIGGERED]: false,
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

module.exports = {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafRequests
}
