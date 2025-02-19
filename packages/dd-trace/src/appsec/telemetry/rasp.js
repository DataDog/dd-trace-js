'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

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

function trackRaspCumulativeDurations (store, metrics, tags) {
  const versionsTags = {
    waf_version: tags.waf_version,
    event_rules_version: tags.event_rules_version
  }

  if (metrics.duration) {
    const raspDuration = store[DD_TELEMETRY_REQUEST_METRICS].raspDuration
    appsecMetrics.distribution('rasp.duration', versionsTags).track(raspDuration)
  }

  if (metrics.durationExt) {
    const raspDurationExt = store[DD_TELEMETRY_REQUEST_METRICS].raspDurationExt
    appsecMetrics.distribution('rasp.duration_ext', versionsTags).track(raspDurationExt)
  }
}

function trackRaspMetrics (store, metrics, tags) {
  trackRaspCumulativeDurations(store, metrics, tags)

  appsecMetrics.count('rasp.rule.eval', tags).inc(1)

  if (metrics.wafTimeout) {
    appsecMetrics.count('rasp.timeout', tags).inc(1)
  }

  if (metrics.ruleTriggered) {
    appsecMetrics.count('rasp.rule.match', tags).inc(1)
  }

  if (metrics.duration) {
    appsecMetrics.distribution('rasp.rule.duration', tags).track(metrics.duration)
  }

  if (metrics.errorCode) {
    const errorTags = { ...tags, waf_error: metrics.errorCode }

    appsecMetrics.count('rasp.error', errorTags).inc(1)
  }
}

module.exports = {
  addRaspRequestMetrics,
  trackRaspMetrics
}
