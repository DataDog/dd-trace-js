'use strict'

module.exports = {
  SAMPLE_RATE_METRIC_KEY: '_sample_rate',
  SAMPLING_PRIORITY_KEY: '_sampling_priority_v1',
  ANALYTICS_KEY: '_dd1.sr.eausr',
  ORIGIN_KEY: '_dd.origin',
  HOSTNAME_KEY: '_dd.hostname',
  SAMPLING_RULE_DECISION: '_dd.rule_psr',
  SAMPLING_LIMIT_DECISION: '_dd.limit_psr',
  SAMPLING_AGENT_DECISION: '_dd.agent_psr',
  SAMPLING_MECHANISM_DEFAULT: 0,
  SAMPLING_MECHANISM_AGENT: 1,
  SAMPLING_MECHANISM_RULE: 3,
  SAMPLING_MECHANISM_MANUAL: 4,
  DATADOG_LAMBDA_EXTENSION_PATH: '/opt/extensions/datadog-agent',
  UPSTREAM_SERVICES_KEY: '_dd.p.upstream_services'
}
