'use strict'

const telemetryMetrics = require('../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')
const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

const tags = {
  BLOCK_FAILURE: 'block_failure',
  EVENT_RULES_VERSION: 'event_rules_version',
  INPUT_TRUNCATED: 'input_truncated',
  REQUEST_BLOCKED: 'request_blocked',
  RULE_TRIGGERED: 'rule_triggered',
  WAF_ERROR: 'waf_error',
  WAF_TIMEOUT: 'waf_timeout',
  WAF_VERSION: 'waf_version'
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
      durationExt: 0,
      raspDuration: 0,
      raspDurationExt: 0,
      raspEvalCount: 0,
      raspErrorCode: null,
      raspTimeouts: 0,
      wafErrorCode: null,
      wafTimeouts: 0
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

  if (metrics.wafTimeouts) {
    appsecMetrics.distribution('waf.timeouts', versionsTags).track(metrics.wafTimeouts)
  }
}

function trackRaspDurations (metrics, tags) {
  const versionsTags = {
    waf_version: tags.waf_version,
    event_rules_version: tags.event_rules_version
  }

  if (metrics.raspDuration) {
    // Incorrect
    appsecMetrics.distribution('rasp.rule.duration', tags).track(metrics.raspDuration)
  }

  if (metrics.raspDuration) {
    appsecMetrics.distribution('rasp.duration', versionsTags).track(metrics.raspDuration)
  }

  if (metrics.raspDurationExt) {
    appsecMetrics.distribution('rasp.duration_ext', versionsTags).track(metrics.raspDurationExt)
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

function updateRaspRequestsMetricTags (metrics, req, raspRule) {
  if (!req) return

  const store = getStore(req)

  // it does not depend on whether telemetry is enabled or not
  addRaspRequestMetrics(store, metrics)

  if (!enabled) return

  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  const tags = { ...versionsTags, rule_type: raspRule.type }

  if (raspRule.variant) {
    tags.rule_variant = raspRule.variant
  }

  trackRaspDurations(metrics, tags)

  appsecMetrics.count('rasp.rule.eval', tags).inc(1)

  if (metrics.wafTimeout) {
    appsecMetrics.count('rasp.timeout', tags).inc(1)
  }

  if (metrics.ruleTriggered) {
    appsecMetrics.count('rasp.rule.match', tags).inc(1)
  }

  if (metrics.errorCode) {
    const errorTags = { ...versionsTags, ...tags, waf_error: metrics.errorCode }

    appsecMetrics.count('rasp.error', errorTags).inc(1)
  }
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

  if (metrics.errorCode) {
    const errorTags = { ...versionsTags, waf_error: metrics.errorCode }

    appsecMetrics.count('waf.error', errorTags).inc(1)
    metricTags[tags.WAF_ERROR] = true
  }

  incrementTruncatedMetrics(metrics)
}

function incrementWafInitMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  const initTags = { ...versionsTags, success }

  appsecMetrics.count('waf.init', initTags).inc()
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  const updateTags = { ...versionsTags, success }

  appsecMetrics.count('waf.updates', updateTags).inc()
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

function incrementTruncatedMetrics (metrics) {
  const truncationReason = getTruncationReason(metrics)

  if (truncationReason > 0) {
    const truncationTags = { truncation_reason: 1 }
    appsecMetrics.count('appsec.waf.input_truncated', truncationTags).inc(1)
  }

  if (metrics?.maxTruncatedString) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size', { truncation_reason: 1 })
      .track(metrics.maxTruncatedString)
  }

  if (metrics?.maxTruncatedContainerSize) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size', { truncation_reason: 2 })
      .track(metrics.maxTruncatedContainerSize)
  }

  if (metrics?.maxTruncatedContainerDepth) {
    appsecMetrics.distribution('appsec.waf.truncated_value_size', { truncation_reason: 4 })
      .track(metrics.maxTruncatedContainerDepth)
  }
}

function addRequestMetrics (store, metrics) {
  const { duration, durationExt, wafTimeout, errorCode } = metrics

  store[DD_TELEMETRY_REQUEST_METRICS].duration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].durationExt += durationExt || 0

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafTimeout++
  }

  if (errorCode != null) {
    store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode = Math.max(
      errorCode,
      store[DD_TELEMETRY_REQUEST_METRICS].wafErrorCode ?? errorCode
    )
  }

  if (getTruncationReason(metrics) > 0) {
    store[DD_TELEMETRY_REQUEST_METRICS].input_truncated = true
  }
}

function addRaspRequestMetrics (store, { duration, durationExt, wafTimeout, errorCode }) {
  store[DD_TELEMETRY_REQUEST_METRICS].raspDuration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspDurationExt += durationExt || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspEvalCount++

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].raspTimeouts++
  }

  if (errorCode != null) {
    store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode = Math.max(
      errorCode,
      store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode ?? errorCode
    )
  }
}

function incrementMissingUserLoginMetric (framework, eventType) {
  if (!enabled) return

  appsecMetrics.count('instrum.user_auth.missing_user_login', {
    framework,
    event_type: eventType
  }).inc()
}

function incrementMissingUserIdMetric (framework, eventType) {
  if (!enabled) return

  appsecMetrics.count('instrum.user_auth.missing_user_id', {
    framework,
    event_type: eventType
  }).inc()
}

function getRequestMetrics (req) {
  if (req) {
    const store = getStore(req)
    return store?.[DD_TELEMETRY_REQUEST_METRICS]
  }
}

function getTruncationReason ({ maxTruncatedString, maxTruncatedContainerSize, maxTruncatedContainerDepth }) {
  let reason = 0

  if (maxTruncatedString) reason |= 1 // string too long
  if (maxTruncatedContainerSize) reason |= 2 // list/map too large
  if (maxTruncatedContainerDepth) reason |= 4 // object too deep

  return reason
}

module.exports = {
  enable,
  disable,

  updateWafRequestsMetricTags,
  updateRaspRequestsMetricTags,
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,
  incrementMissingUserLoginMetric,
  incrementMissingUserIdMetric,

  getRequestMetrics
}
