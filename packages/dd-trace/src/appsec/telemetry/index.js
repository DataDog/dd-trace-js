'use strict'

const { DD_TELEMETRY_REQUEST_METRICS } = require('./common')
const { incrementMissingUserId, incrementMissingUserLogin, incrementSdkEvent } = require('./user')
const {
  addRaspRequestMetrics,
  trackRaspMetrics,
  trackRaspRuleMatch,
  trackRaspRuleSkipped
} = require('./rasp')
const {
  addWafRequestMetrics,
  trackWafMetrics,
  incrementWafInit,
  incrementWafUpdates,
  incrementWafRequests
} = require('./waf')

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
      wafTimeouts: 0,
      raspTimeouts: 0,
      wafErrorCode: null,
      raspErrorCode: null,
      wafVersion: null,
      rulesVersion: null
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

function updateRaspRequestsMetricTags (metrics, req, raspRule) {
  if (!req) return

  const store = getStore(req)

  // it does not depend on whether telemetry is enabled or not
  addRaspRequestMetrics(store, metrics)

  if (!enabled) return

  trackRaspMetrics(store, metrics, raspRule)
}

function updateRaspRuleMatchMetricTags (req, raspRule, blockTriggered, blocked) {
  if (!enabled || !req) return

  const store = getStore(req)

  trackRaspRuleMatch(store, raspRule, blockTriggered, blocked)
}

function updateRaspRuleSkippedMetricTags (raspRule, reason) {
  if (!enabled) return

  trackRaspRuleSkipped(raspRule, reason)
}

function updateWafRequestsMetricTags (metrics, req) {
  if (!req) return

  const store = getStore(req)

  // it does not depend on whether telemetry is enabled or not
  addWafRequestMetrics(store, metrics)

  if (!enabled) return

  return trackWafMetrics(store, metrics)
}

function updateRateLimitedMetric (req) {
  if (!enabled) return

  const store = getStore(req)
  trackWafMetrics(store, { rateLimited: true })
}

function updateBlockFailureMetric (req) {
  if (!enabled) return

  const store = getStore(req)
  trackWafMetrics(store, { blockFailed: true })
}

function incrementWafInitMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  incrementWafInit(wafVersion, rulesVersion, success)
}

function incrementWafUpdatesMetric (wafVersion, rulesVersion, success) {
  if (!enabled) return

  incrementWafUpdates(wafVersion, rulesVersion, success)
}

function incrementWafRequestsMetric (req) {
  if (!req || !enabled) return

  const store = getStore(req)
  incrementWafRequests(store)

  metricsStoreMap.delete(req)
}

function incrementMissingUserLoginMetric (framework, eventType) {
  if (!enabled) return

  incrementMissingUserLogin(framework, eventType)
}

function incrementMissingUserIdMetric (framework, eventType) {
  if (!enabled) return

  incrementMissingUserId(framework, eventType)
}

function incrementSdkEventMetric (eventType, sdkVersion) {
  if (!enabled) return

  incrementSdkEvent(eventType, sdkVersion)
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
  updateRateLimitedMetric,
  updateBlockFailureMetric,
  updateRaspRequestsMetricTags,
  updateRaspRuleMatchMetricTags,
  updateRaspRuleSkippedMetricTags,
  incrementWafInitMetric,
  incrementWafUpdatesMetric,
  incrementWafRequestsMetric,
  incrementMissingUserLoginMetric,
  incrementMissingUserIdMetric,
  incrementSdkEventMetric,

  getRequestMetrics
}
