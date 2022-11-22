'use strict'

module.exports = {
  SAMPLING_PRIORITY_KEY: '_sampling_priority_v1',
  ANALYTICS_KEY: '_dd1.sr.eausr',
  ORIGIN_KEY: '_dd.origin',
  HOSTNAME_KEY: '_dd.hostname',
  TOP_LEVEL_KEY: '_dd.top_level',
  SAMPLING_RULE_DECISION: '_dd.rule_psr',
  SAMPLING_LIMIT_DECISION: '_dd.limit_psr',
  SAMPLING_AGENT_DECISION: '_dd.agent_psr',
  SAMPLING_MECHANISM_DEFAULT: 0,
  SAMPLING_MECHANISM_AGENT: 1,
  SAMPLING_MECHANISM_RULE: 3,
  SAMPLING_MECHANISM_MANUAL: 4,
  SAMPLING_MECHANISM_APPSEC: 5,
  SAMPLING_MECHANISM_SPAN: 8,
  SPAN_SAMPLING_MECHANISM: '_dd.span_sampling.mechanism',
  SPAN_SAMPLING_RULE_RATE: '_dd.span_sampling.rule_rate',
  SPAN_SAMPLING_MAX_PER_SECOND: '_dd.span_sampling.max_per_second',
  DATADOG_LAMBDA_EXTENSION_PATH: '/opt/extensions/datadog-agent',
  DECISION_MAKER_KEY: '_dd.p.dm',
  PROCESS_ID: 'process_id',
  ERROR_TYPE: 'error.type',
  ERROR_MESSAGE: 'error.message',
  ERROR_STACK: 'error.stack'
}
