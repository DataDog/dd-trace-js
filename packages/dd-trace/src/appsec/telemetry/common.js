'use strict'

const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

const tags = {
  BLOCK_FAILURE: 'block_failure',
  EVENT_RULES_VERSION: 'event_rules_version',
  INPUT_TRUNCATED: 'input_truncated',
  RATE_LIMITED: 'rate_limited',
  REQUEST_BLOCKED: 'request_blocked',
  RULE_TRIGGERED: 'rule_triggered',
  WAF_ERROR: 'waf_error',
  WAF_TIMEOUT: 'waf_timeout',
  WAF_VERSION: 'waf_version'
}

function getVersionsTags (wafVersion, rulesVersion) {
  return {
    [tags.WAF_VERSION]: wafVersion,
    [tags.EVENT_RULES_VERSION]: rulesVersion || 'unknown'
  }
}

module.exports = {
  tags,
  getVersionsTags,
  DD_TELEMETRY_REQUEST_METRICS
}
