'use strict'

const assert = require('node:assert/strict')
const { getWebSpan } = require('../utils')

function checkRaspExecutedAndNotThreat (agent, checkRuleEval = true, timeoutMs) {
  return agent.assertSomeTraces((traces) => {
    const span = getWebSpan(traces)
    assert.ok(!('_dd.appsec.json' in span.meta))
    assert.ok(!span.meta_struct || !('_dd.stack' in span.meta_struct))
    if (checkRuleEval) {
      assert.strictEqual(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
    }
  }, { timeoutMs })
}

function checkRaspExecutedAndHasThreat (agent, ruleId, ruleEvalCount = 1) {
  return agent.assertSomeTraces((traces) => {
    const span = getWebSpan(traces)
    assert.ok(Object.hasOwn(span.meta, '_dd.appsec.json'))
    assert(span.meta['_dd.appsec.json'].includes(ruleId))
    assert.strictEqual(span.metrics['_dd.appsec.rasp.rule.eval'], ruleEvalCount)
    assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
    assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
    assert.ok(Object.hasOwn(span.meta_struct, '_dd.stack'))

    return span
  })
}

module.exports = {
  checkRaspExecutedAndNotThreat,
  checkRaspExecutedAndHasThreat,
}
