'use strict'

const { manager } = require('../../telemetry/metrics')

const RULE_TYPES = {
  SSRF: 'ssrf'
}

let wafVersion, raspNamespace
function countRuleEval (ruleType) {
  raspNamespace.count('appsec.rasp.rule.eval', { rule_type: ruleType, waf_version: wafVersion }).inc(1)
}

function countTimeout (ruleType) {
  raspNamespace.count('appsec.rasp.timeout', { rule_type: ruleType, waf_version: wafVersion }).inc(1)
}

function init (_wafVersion) {
  wafVersion = _wafVersion
  raspNamespace = manager.namespace('rasp')
}

module.exports = {
  init,
  countRuleEval,
  countTimeout,
  RULE_TYPES
}
