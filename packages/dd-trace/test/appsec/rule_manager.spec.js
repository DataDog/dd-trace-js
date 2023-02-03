'use strict'

const { applyRules, clearAllRules, updateAsmData, toggleRules } = require('../../src/appsec/rule_manager')
const callbacks = require('../../src/appsec/callbacks')
const Gateway = require('../../src/appsec/gateway/engine')

const rules = [{ a: 'thatsarule' }, { b: 'thatsanotherone' }]

describe('AppSec Rule Manager', () => {
  let FakeDDWAF

  beforeEach(() => {
    FakeDDWAF = sinon.spy()

    FakeDDWAF.prototype.clear = sinon.spy()
    FakeDDWAF.prototype.updateRuleData = sinon.spy()
    FakeDDWAF.prototype.toggleRules = sinon.spy()

    sinon.stub(callbacks, 'DDWAF').get(() => FakeDDWAF)
  })

  afterEach(() => {
    sinon.restore()
    clearAllRules()
  })

  describe('applyRules', () => {
    it('should apply a DDWAF rule only idempotently', () => {
      const config = {}

      applyRules(rules, config)

      applyRules(rules)

      expect(callbacks.DDWAF).to.have.been.calledOnce
      expect(FakeDDWAF).to.have.been.calledOnceWithExactly(rules, config)
    })
  })

  describe('clearAllRules', () => {
    it('should call clear method on all applied rules', () => {
      applyRules(rules)

      expect(callbacks.DDWAF).to.have.been.calledOnce
      expect(FakeDDWAF).to.have.been.calledOnce

      sinon.stub(Gateway.manager, 'clear')

      clearAllRules()

      expect(Gateway.manager.clear).to.have.been.calledOnce
      expect(FakeDDWAF.prototype.clear).to.have.been.calledOnce

      applyRules(rules)

      expect(callbacks.DDWAF).to.have.been.calledTwice
      expect(FakeDDWAF).to.have.been.calledTwice
    })
  })

  describe('updateAsmData', () => {
    it('should call updateAsmData on all applied rules', () => {
      const rulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      applyRules(rules)
      updateAsmData('apply', { rules_data: rulesData }, '1')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledOnceWithExactly(rulesData)
    })

    it('should merge rules data with same dataId and no expiration', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'def' }
        ]
      }]

      const expectedMergedRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' },
          { value: 'def' }
        ]
      }]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall.args[0]).to.deep.equal(expectedMergedRulesData)
    })

    it('should merge rules data with different dataId and no expiration', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataB',
        type: 'dataType',
        data: [
          { value: 'def' }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc' }
          ]
        },
        {
          id: 'dataB',
          type: 'dataType',
          data: [
            { value: 'def' }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall.args[0]).to.deep.equal(expectedMergedRulesData)
    })

    it('should merge rules data with different expiration', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 100 }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 200 }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc', expiration: 200 }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall.args[0]).to.deep.equal(expectedMergedRulesData)
    })

    it('should merge rules data with different expiration different order', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 200 }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 100 }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc', expiration: 200 }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall.args[0]).to.deep.equal(expectedMergedRulesData)
    })

    it('should merge rules data with and without expiration', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 200 }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc' }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
    })

    it('should merge rules data with and without expiration different order', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 200 }
        ]
      }]

      const anotherRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc' }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.calledTwice
      expect(FakeDDWAF.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
    })

    it('should merge and unapply rules data', () => {
      const oneRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 200 }
        ]
      }]

      const twoRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc' }
        ]
      }]

      const threeRulesData = [{
        id: 'dataA',
        type: 'dataType',
        data: [
          { value: 'abc', expiration: 100 }
        ]
      }]

      const expectedMergedRulesData = [
        {
          id: 'dataA',
          type: 'dataType',
          data: [
            { value: 'abc', expiration: 200 }
          ]
        }
      ]

      applyRules(rules)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: twoRulesData }, 'id2')
      updateAsmData('apply', { rules_data: threeRulesData }, 'id3')
      updateAsmData('unapply', null, 'id2')

      expect(FakeDDWAF.prototype.updateRuleData).to.have.been.callCount(4)
      expect(FakeDDWAF.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
    })
  })

  describe('toggleRules', () => {
    it('should call WAF toggleRules with rulesOverride data', () => {
      const rulesOverride = {
        rules_override: [
          {
            enabled: false,
            id: 'crs-941-300'
          },
          {
            enabled: false,
            id: 'test-3'
          }
        ]
      }

      applyRules(rules)
      toggleRules('apply', rulesOverride, '1')

      expect(FakeDDWAF.prototype.toggleRules).to.have.been.calledOnceWithExactly(rulesOverride.rules_override)
    })

    it('should not call WAF toggleRules when rules_overrides is not present in data', () => {
      const rulesOverride = {
      }

      applyRules(rules)
      toggleRules('apply', rulesOverride, '1')

      expect(FakeDDWAF.prototype.toggleRules).to.not.have.been.called
    })

    it('should not call WAF toggleRules when action is not apply', () => {
      const rulesOverride = {
        rules_override: [
          {
            enabled: false,
            id: 'crs-941-300'
          },
          {
            enabled: false,
            id: 'test-3'
          }
        ]
      }

      applyRules(rules)
      toggleRules('modified', rulesOverride, '1')
      toggleRules('unapply', rulesOverride, '2')

      expect(FakeDDWAF.prototype.toggleRules).to.not.have.been.called
    })

    it('should call WAF toggleRules ignoring the empty overrides', () => {
      const rulesOverride = {
        rules_override: [
          {
            enabled: false,
            id: 'crs-941-300'
          },
          {
            id: 'empty override'
          }
        ]
      }

      const expectedRulesOverride = [
        {
          enabled: false,
          id: 'crs-941-300'
        }
      ]

      applyRules(rules)
      toggleRules('apply', rulesOverride, '1')
      expect(FakeDDWAF.prototype.toggleRules).to.have.been.calledOnceWithExactly(expectedRulesOverride)
    })
  })
})
