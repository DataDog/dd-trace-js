'use strict'

const { assert } = require('chai')
const { getWebSpan } = require('../utils')

function checkRaspExecutedAndNotThreat (agent, checkRuleEval = true) {
  return agent.assertSomeTraces((traces) => {
    try {
      const span = getWebSpan(traces)
      assert.notProperty(span.meta, '_dd.appsec.json')
      assert.notProperty(span.meta_struct || {}, '_dd.stack')
      if (checkRuleEval) {
        assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
      }
    } catch (error) {
      console.log('Error', traces)
      throw error
    }

  })
}

function checkRaspExecutedAndHasThreat (agent, ruleId, ruleEvalCount = 1) {
  return agent.assertSomeTraces((traces) => {
    const span = getWebSpan(traces)
    assert.property(span.meta, '_dd.appsec.json')
    assert(span.meta['_dd.appsec.json'].includes(ruleId))
    assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], ruleEvalCount)
    assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
    assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
    assert.property(span.meta_struct, '_dd.stack')

    return span
  })
}

module.exports = {
  checkRaspExecutedAndNotThreat,
  checkRaspExecutedAndHasThreat
}
