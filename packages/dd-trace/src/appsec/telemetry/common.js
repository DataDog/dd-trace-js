'use strinct'

const DD_TELEMETRY_REQUEST_METRICS = Symbol('_dd.appsec.telemetry.request.metrics')

const tags = {
  REQUEST_BLOCKED: 'request_blocked',
  RULE_TRIGGERED: 'rule_triggered',
  WAF_TIMEOUT: 'waf_timeout',
  WAF_VERSION: 'waf_version',
  EVENT_RULES_VERSION: 'event_rules_version'
}

function getVersionsTags (wafVersion, rulesVersion) {
  return {
    [tags.WAF_VERSION]: wafVersion,
    [tags.EVENT_RULES_VERSION]: rulesVersion
  }
}

module.exports = {
  tags,
  getVersionsTags,
  DD_TELEMETRY_REQUEST_METRICS
}
