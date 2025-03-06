'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { DD_TELEMETRY_REQUEST_METRICS } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

function addRaspRequestMetrics (store, { duration, durationExt, wafTimeout, errorCode }) {
  store[DD_TELEMETRY_REQUEST_METRICS].raspDuration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspDurationExt += durationExt || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspEvalCount++

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].raspTimeouts++
  }

  if (errorCode) {
    if (store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode) {
      store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode = Math.max(
        errorCode,
        store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode
      )
    } else {
      store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode = errorCode
    }
  }
}

function trackRaspMetrics (metrics, raspRule) {
  const tags = { rule_type: raspRule.type, waf_version: metrics.wafVersion }

  if (raspRule.variant) {
    tags.rule_variant = raspRule.variant
  }

  appsecMetrics.count('rasp.rule.eval', tags).inc(1)

  if (metrics.wafTimeout) {
    appsecMetrics.count('rasp.timeout', tags).inc(1)
  }

  if (metrics.ruleTriggered) {
    appsecMetrics.count('rasp.rule.match', tags).inc(1)
  }
}

module.exports = {
  addRaspRequestMetrics,
  trackRaspMetrics
}
