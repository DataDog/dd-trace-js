'use strict'

const { clearCache, getMetric } = require('./cache')
const { WAF_VERSION, EVENT_RULES_VERSION, REQUEST_BLOCKED, RULE_TRIGGERED, WAF_TIMEOUT } = require('./tags')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')

const metricsStoreMap = new WeakMap()

let enabled = false

function enable (telemetryConfig) {
  enabled = telemetryConfig?.enabled && telemetryConfig.metrics
}

function disable () {
  enabled = false
  clearCache()
}

function getStore (req) {
  let store = metricsStoreMap.get(req)
  if (!store) {
    store = {}
    metricsStoreMap.set(req, store)
  }
  return store
}

function getVersionsTags (wafVersion, rulesVersion) {
  return {
    [WAF_VERSION]: wafVersion,
    [EVENT_RULES_VERSION]: rulesVersion
  }
}

function trackWafDurations (metrics, versionsTags) {
  if (metrics.duration) {
    getMetric('waf.duration', versionsTags, 'distribution').track(metrics.duration)
  }
  if (metrics.durationExt) {
    getMetric('waf.duration_ext', versionsTags, 'distribution').track(metrics.durationExt)
  }
}

function getOrCreateMetricTags (req, versionsTags) {
  const store = getStore(req)

  let metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (!metricTags) {
    metricTags = {
      [REQUEST_BLOCKED]: false,
      [RULE_TRIGGERED]: false,
      [WAF_TIMEOUT]: false,

      ...versionsTags
    }
    store[DD_TELEMETRY_WAF_RESULT_TAGS] = metricTags
  }
  return metricTags
}

function updateWafRequestsMetricTags (metrics, req) {
  if (!req || !enabled) return

  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  trackWafDurations(metrics, versionsTags)

  const metricTags = getOrCreateMetricTags(req, versionsTags)

  const { blockTriggered, ruleTriggered, wafTimeout } = metrics

  if (blockTriggered) {
    metricTags[REQUEST_BLOCKED] = blockTriggered
  }
  if (ruleTriggered) {
    metricTags[RULE_TRIGGERED] = ruleTriggered
  }
  if (wafTimeout) {
    metricTags[WAF_TIMEOUT] = wafTimeout
  }

  return metricTags
}

function incrementWafInitMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  getMetric('waf.init', versionsTags).inc()
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  getMetric('waf.updates', versionsTags).inc()
}

function incrementWafRequestsMetric (req) {
  if (!req || !enabled) return

  const store = getStore(req)

  const metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (metricTags) {
    getMetric('waf.requests', metricTags).inc()
  }

  metricsStoreMap.delete(req)
}

module.exports = {
  enable,
  disable,

  updateWafRequestsMetricTags,
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric
}
