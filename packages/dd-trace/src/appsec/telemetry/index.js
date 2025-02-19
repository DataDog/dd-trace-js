'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const { addRaspRequestMetrics, trackRaspMetrics } = require('./rasp')
const { incrementMissingUserId, incrementMissingUserLogin } = require('./user')
const {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafRequests
} = require('./waf')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

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

  trackRaspMetrics(store, metrics, tags)

  incrementTruncatedMetrics(metrics)
}

function updateWafRequestsMetricTags (metrics, req) {
  if (!req) return

  const store = getStore(req)

  // it does not depend on whether telemetry is enabled or not
  addWafRequestMetrics(store, metrics)

  if (!enabled) return

  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)

  trackWafMetrics(store, metrics, versionsTags)

  incrementTruncatedMetrics(metrics)
}

function incrementWafInitMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  incrementWafInit(versionsTags, success)
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  const versionsTags = getVersionsTags(wafVersion, rulesVersion)
  incrementWafUpdates(versionsTags, success)
}

function incrementWafRequestsMetric (req) {
  if (!req || !enabled) return

  const store = getStore(req)
  incrementWafRequests(store)

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

function incrementMissingUserLoginMetric (framework, eventType) {
  if (!enabled) return

  incrementMissingUserLogin(framework, eventType)
}

function incrementMissingUserIdMetric (framework, eventType) {
  if (!enabled) return

  incrementMissingUserId(framework, eventType)
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
