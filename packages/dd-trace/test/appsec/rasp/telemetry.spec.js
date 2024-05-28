'use strict'

const proxyquire = require('proxyquire')

describe('RASP telemetry', () => {
  const wafVersion = '1.2.3'
  const ruleType = 'RULE_TYPE'
  let namespace, count, inc, telemetry

  beforeEach(() => {
    inc = sinon.spy()
    count = sinon.spy(() => ({ inc }))
    namespace = () => {
      return { count }
    }

    const manager = {
      namespace
    }

    telemetry = proxyquire('../../../src/appsec/rasp/telemetry', {
      '../../telemetry/metrics': { manager }
    })

    telemetry.init(wafVersion)
  })

  afterEach(() => {
    telemetry = null
  })

  it('should count rule evaluation', () => {
    telemetry.countRuleEval(ruleType)

    sinon.assert.calledOnce(count)
    sinon.assert.calledWith(count, 'appsec.rasp.rule.eval', { rule_type: ruleType, waf_version: wafVersion })
    sinon.assert.calledOnce(inc)
    sinon.assert.calledWith(inc, 1)
  })

  it('should count timeout', () => {
    telemetry.countTimeout(ruleType)

    sinon.assert.calledOnce(count)
    sinon.assert.calledWith(count, 'appsec.rasp.timeout', { rule_type: ruleType, waf_version: wafVersion })
    sinon.assert.calledOnce(inc)
    sinon.assert.calledWith(inc, 1)
  })
})
