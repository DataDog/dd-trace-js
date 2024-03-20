'use strict'

const telemetryMetrics = require('../../telemetry/metrics')
const { REQUEST_BLOCKED, RULE_TRIGGERED, WAF_TIMEOUT, EVENT_RULES_VERSION } = require('./tags')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const cacheKeyProvider = {
  'waf.requests': (metricTags) => {
    let key
    if (metricTags[REQUEST_BLOCKED]) {
      key = 'waf.requests-blocked'
    } else if (metricTags[RULE_TRIGGERED]) {
      key = 'waf.requests-rule-triggered'
    } else {
      key = 'waf.requests-normal'
    }

    if (metricTags[WAF_TIMEOUT]) {
      key += '-timeout'
    }

    return key
  }
}

const metricsCache = new Map()

let currentRulesVersion

function getMetricKey (name, tags) {
  return cacheKeyProvider[name] ? cacheKeyProvider[name](tags) : name
}

function getMetric (metricName, metricTags = {}, type = 'count') {
  const rulesVersion = metricTags[EVENT_RULES_VERSION]
  if (!rulesVersion) return

  if (rulesVersion !== currentRulesVersion) {
    metricsCache.clear()
    currentRulesVersion = rulesVersion
  }

  const metricKey = getMetricKey(metricName, metricTags)

  let metric = metricsCache.get(metricKey)
  if (!metric) {
    metric = appsecMetrics[type](metricName, metricTags)
    metricsCache.set(metricKey, metric)
  }

  return metric
}

function clearCache () {
  metricsCache.clear()
}

module.exports = {
  getMetric,
  clearCache
}
