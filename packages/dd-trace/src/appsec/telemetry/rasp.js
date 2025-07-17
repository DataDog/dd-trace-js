'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { DD_TELEMETRY_REQUEST_METRICS, getVersionsTags } = require('./common')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const BLOCKING_STATUS = {
  FAILURE: 'failure',
  IRRELEVANT: 'irrelevant',
  SUCCESS: 'success'
}

function addRaspRequestMetrics (store, { duration, durationExt, wafTimeout, errorCode }) {
  store[DD_TELEMETRY_REQUEST_METRICS].raspDuration += duration || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspDurationExt += durationExt || 0
  store[DD_TELEMETRY_REQUEST_METRICS].raspEvalCount++

  if (wafTimeout) {
    store[DD_TELEMETRY_REQUEST_METRICS].raspTimeouts++
  }

  if (errorCode) {
    store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode = store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode
      ? Math.max(
        errorCode,
        store[DD_TELEMETRY_REQUEST_METRICS].raspErrorCode
      )
      : errorCode
  }
}

function trackRaspMetrics (store, metrics, raspRule) {
  const versionsTags = getVersionsTags(metrics.wafVersion, metrics.rulesVersion)
  const tags = { rule_type: raspRule.type, ...versionsTags }
  const telemetryMetrics = store[DD_TELEMETRY_REQUEST_METRICS]

  if (raspRule.variant) {
    tags.rule_variant = raspRule.variant
  }

  if (metrics.wafVersion) {
    telemetryMetrics.wafVersion = metrics.wafVersion
  }

  if (metrics.rulesVersion) {
    telemetryMetrics.rulesVersion = metrics.rulesVersion
  }

  appsecMetrics.count('rasp.rule.eval', tags).inc(1)

  if (metrics.errorCode) {
    const errorTags = { ...tags, waf_error: metrics.errorCode }

    appsecMetrics.count('rasp.error', errorTags).inc(1)
  }

  if (metrics.wafTimeout) {
    appsecMetrics.count('rasp.timeout', tags).inc(1)
  }
}

function trackRaspRuleMatch (store, raspRule, blockTriggered, blocked) {
  const telemetryMetrics = store[DD_TELEMETRY_REQUEST_METRICS]

  const tags = {
    waf_version: telemetryMetrics.wafVersion,
    event_rules_version: telemetryMetrics.rulesVersion,
    rule_type: raspRule.type,
    block: getRuleMatchBlockingStatus(blockTriggered, blocked)
  }

  if (raspRule.variant) {
    tags.rule_variant = raspRule.variant
  }

  appsecMetrics.count('rasp.rule.match', tags).inc(1)
}

function trackRaspRuleSkipped (raspRule, reason) {
  const tags = { reason, rule_type: raspRule.type }

  if (raspRule.variant) {
    tags.rule_variant = raspRule.variant
  }

  appsecMetrics.count('rasp.rule.skipped', tags).inc(1)
}

function getRuleMatchBlockingStatus (blockTriggered, blocked) {
  if (!blockTriggered) {
    return BLOCKING_STATUS.IRRELEVANT
  }

  return blocked ? BLOCKING_STATUS.SUCCESS : BLOCKING_STATUS.FAILURE
}

module.exports = {
  addRaspRequestMetrics,
  trackRaspMetrics,
  trackRaspRuleMatch,
  trackRaspRuleSkipped
}
