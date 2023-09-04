'use strict'

const telemetryMetrics = require('../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAG = Symbol('_dd.appsec.telemetry.waf.result.tag')

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

function getStore (req) {
  let store = metricsStoreMap.get(req)
  if (!store) {
    store = {}
    metricsStoreMap.set(req, store)
  }
  return store
}

function getVersionsTag (wafVersion, rulesVersion) {
  return {
    [tags.WAF_VERSION]: wafVersion,
    [tags.EVENT_RULES_VERSION]: rulesVersion
  }
}

function trackWafDurations (metrics) {
  const tag = getVersionsTag(metrics.wafVersion, metrics.rulesVersion)

  if (metrics.duration) {
    appsecMetrics.distribution('waf.duration', tag).track(metrics.duration)
  }
  if (metrics.durationExt) {
    appsecMetrics.distribution('waf.duration_ext', tag).track(metrics.durationExt)
  }
}

function getOrCreateMetricTag ({ wafVersion, rulesVersion }, req) {
  const store = getStore(req)

  let tag = store[DD_TELEMETRY_WAF_RESULT_TAG]
  if (!tag) {
    tag = {
      [tags.REQUEST_BLOCKED]: false,
      [tags.RULE_TRIGGERED]: false,
      [tags.WAF_TIMEOUT]: false,

      ...getVersionsTag(wafVersion, rulesVersion)
    }
    store[DD_TELEMETRY_WAF_RESULT_TAG] = tag
  }
  return tag
}

function updateWafRequestsTag (metrics, req) {
  if (!req || !enabled) return

  trackWafDurations(metrics)

  const tag = getOrCreateMetricTag(metrics, req)

  const { requestBlocked, ruleTriggered, wafTimeout } = metrics

  if (requestBlocked) {
    tag[tags.REQUEST_BLOCKED] = requestBlocked
  }
  if (ruleTriggered) {
    tag[tags.RULE_TRIGGERED] = ruleTriggered
  }
  if (wafTimeout) {
    tag[tags.WAF_TIMEOUT] = wafTimeout
  }

  return tag
}

function incrementWafInitMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const tag = getVersionsTag(wafVersion, rulesVersion)

  appsecMetrics.count('waf.init', tag).inc()
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion) {
  if (!enabled) return

  const tag = getVersionsTag(wafVersion, rulesVersion)

  appsecMetrics.count('waf.updates', tag).inc()
}

function incrementWafRequestsMetric (req) {
  if (!req || !enabled) return

  const store = getStore(req)

  const tag = store[DD_TELEMETRY_WAF_RESULT_TAG]
  if (tag) {
    appsecMetrics.count('waf.requests', tag).inc()
  }

  metricsStoreMap.delete(req)
}

module.exports = {
  enable,
  disable,

  updateWafRequestsTag,
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric
}
