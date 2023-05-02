'use strict'

const telemetry = require('../telemetry')
const { WAF_DURATION, WAF_DURATION_EXT, WAF_REQUESTS, WAF_INIT, WAF_UPDATES, WafMetricTag } = require('./waf_metric')

const DD_TELEMETRY_WAF_RESULT_TAGS = Symbol('_dd.appsec.telemetry.waf.result.tags')

function getOrCreateMetricTag (metrics, store) {
  let telemetryResultTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (!telemetryResultTags) {
    telemetryResultTags = WafMetricTag.default(metrics.wafVersion, metrics.rulesVersion)
    store[DD_TELEMETRY_WAF_RESULT_TAGS] = telemetryResultTags
  }
  return telemetryResultTags
}

function updateWafResults (metrics, store) {
  if (!store || !telemetry.isEnabled()) return

  incWafDurations(metrics)

  const tag = getOrCreateMetricTag(metrics, store)
  if (metrics.wafTimeout) {
    tag.wafTimeout(metrics.wafTimeout)
  }
  if (metrics.ruleTriggered) {
    tag.ruleTriggered(metrics.ruleTriggered)
  }
  if (metrics.requestBlocked) {
    tag.requestBlocked(metrics.requestBlocked)
  }
}

function incWafDurations (metrics) {
  const tag = WafMetricTag.onlyVersions(metrics.wafVersion, metrics.rulesVersion)
  WAF_DURATION.add(metrics.duration, tag)
  WAF_DURATION_EXT.add(metrics.durationExt, tag)
}

function incWafRequests (store, clearStore = true) {
  const tag = store && store[DD_TELEMETRY_WAF_RESULT_TAGS]
  if (tag) {
    WAF_REQUESTS.increase(tag)

    if (clearStore) {
      delete store[DD_TELEMETRY_WAF_RESULT_TAGS]
    }
  }
}

function incWafInitMetric (wafVersion, rulesVersion) {
  WAF_INIT.increase(WafMetricTag.onlyVersions(wafVersion, rulesVersion))
}

function incWafUpdatesMetric (wafVersion, rulesVersion) {
  WAF_UPDATES.increase(WafMetricTag.onlyVersions(wafVersion, rulesVersion))
}

module.exports = {
  updateWafResults,
  incWafInitMetric,
  incWafUpdatesMetric,
  incWafRequests,

  DD_TELEMETRY_WAF_RESULT_TAGS
}
