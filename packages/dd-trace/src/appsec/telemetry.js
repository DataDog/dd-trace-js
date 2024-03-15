'use strict'

const telemetryMetrics = require('../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')
const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

const tags = {
  REQUEST_BLOCKED: 'request_blocked',
  RULE_TRIGGERED: 'rule_triggered',
  WAF_TIMEOUT: 'waf_timeout',
  WAF_VERSION: 'waf_version',
  EVENT_RULES_VERSION: 'event_rules_version'
}

const metricsStoreMap = new WeakMap()

let enabled = false

function enable (telemetryConfig) {
  enabled = telemetryConfig?.enabled && telemetryConfig.metrics
}

function disable () {
  enabled = false
}

function newStore () {
  return {
    [DD_TELEMETRY_REQUEST_METRICS]: {
      duration: 0,
      durationExt: 0
    }
  }
}

function getStore (req) {
  let store = metricsStoreMap.get(req)
  if (!store) {
    store = newStore()
    metricsStoreMap.set(req, store)
  }
  return store
}

function getVersionsTags (wafVersion, rulesVersion) {
  return {
    [tags.WAF_VERSION]: wafVersion,
    [tags.EVENT_RULES_VERSION]: rulesVersion
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

function updateWafRequestsMetricTags (metrics, req) {
  if (!req) return

  const store = getStore(req)

  // it does not depend on whether telemetry is enabled or not
  addRequestMetrics(store, metrics)

  if (!enabled) return

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

  return metricTags
}

function incrementWafInitMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  appsecMetrics.count('waf.init', versionsTags).inc()
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)

  appsecMetrics.count('waf.updates', versionsTags).inc()
}

function incrementWafRequestsMetric (req) {
  if (!req || !enabled) return

  const store = getStore(req)

  const metricTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (metricTags) {
    appsecMetrics.count('waf.requests', metricTags).inc()
  }

  metricsStoreMap.delete(req)
}

function addRequestMetrics (store, { duration, durationExt }) {
  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0
}

function getRequestMetrics (req) {
  if (req) {
    const store = getStore(req)
    return store?.[DD_TELEMETRY_REQUEST_METRICS]
  }
}

module.exports = {
  enable,
  disable,

  updateWafRequestsMetricTags,
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,

  getRequestMetrics
}
