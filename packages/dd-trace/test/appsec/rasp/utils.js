'use strict'

const { assert } = require('chai')

function getWebSpan (traces, debug) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }
  throw new Error('web span not found')
}

function checkRaspExecutedAndNotThreat (agent, checkRuleEval = true) {
  return agent.use((traces) => {
    const span = getWebSpan(traces)
    assert.notProperty(span.meta, '_dd.appsec.json')
    assert.notProperty(span.meta_struct || {}, '_dd.stack')
    if (checkRuleEval) {
      assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
    }
  })
}

function checkRaspExecutedAndHasThreat (agent, ruleId) {
  return agent.use((traces) => {
    const span = getWebSpan(traces)
    assert.property(span.meta, '_dd.appsec.json')
    assert(span.meta['_dd.appsec.json'].includes(ruleId))
    assert.equal(span.metrics['_dd.appsec.rasp.rule.eval'], 1)
    assert(span.metrics['_dd.appsec.rasp.duration'] > 0)
    assert(span.metrics['_dd.appsec.rasp.duration_ext'] > 0)
    assert.property(span.meta_struct, '_dd.stack')
  })
}

module.exports = {
  getWebSpan,
  checkRaspExecutedAndNotThreat,
  checkRaspExecutedAndHasThreat
}
