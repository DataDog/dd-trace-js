'use strict'

const { applyRules, clearAllRules, updateAsmData, updateAsmDDRules } = require('../../src/appsec/rule_manager')
const Config = require('../../src/config')

const rules = require('../../src/appsec/recommended.json')
const WAFManagerModule = require('../../src/appsec/waf_manager')

describe('AppSec Rule Manager', () => {
  let FakeDDWAF, config

  beforeEach(() => {
    clearAllRules()
    config = new Config()
    FakeDDWAF = sinon.spy()

    FakeDDWAF.prototype.clear = sinon.spy()
    FakeDDWAF.prototype.reload = sinon.spy()
    FakeDDWAF.prototype.updateRuleData = sinon.spy()

    sinon.stub(WAFManagerModule, 'init').callThrough()
    sinon.stub(WAFManagerModule, 'destroy').callThrough()
    sinon.stub(WAFManagerModule.WAFManager.prototype, 'updateRuleData').callThrough()
    sinon.stub(WAFManagerModule.WAFManager.prototype, 'reload').callThrough()
  })

  afterEach(() => {
    sinon.restore()
    clearAllRules()
  })

  describe('applyRules', () => {
    it('should apply a DDWAF rule only idempotently', () => {
      applyRules(rules, config.appsec)

      applyRules(rules, config.appsec)

      expect(WAFManagerModule.init).to.have.been.calledOnceWithExactly(rules, config.appsec)
    })
  })

  describe('clearAllRules', () => {
    it('should call clear method on all applied rules', () => {
      applyRules(rules, config.appsec)
      expect(WAFManagerModule.init).to.have.been.calledOnce

      clearAllRules()

      expect(WAFManagerModule.destroy).to.have.been.calledOnce

      applyRules(rules, config.appsec)

      expect(WAFManagerModule.init).to.have.been.calledTwice
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: rulesData }, '1')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledOnceWithExactly(rulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall.args[0])
        .to.deep.equal(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall.args[0])
        .to.deep.equal(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall.args[0])
        .to.deep.equal(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall.args[0])
        .to.deep.equal(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: anotherRulesData }, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.calledTwice
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
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

      applyRules(rules, config.appsec)
      updateAsmData('apply', { rules_data: oneRulesData }, 'id1')
      updateAsmData('apply', { rules_data: twoRulesData }, 'id2')
      updateAsmData('apply', { rules_data: threeRulesData }, 'id3')
      updateAsmData('unapply', null, 'id2')

      expect(WAFManagerModule.WAFManager.prototype.updateRuleData).to.have.been.callCount(4)
      expect(WAFManagerModule.WAFManager.prototype.updateRuleData.lastCall).calledWithExactly(expectedMergedRulesData)
    })
  })

  describe('updateAsmDDRules', () => {
    beforeEach(() => {
      applyRules(rules, config.appsec)
    })

    it('should create new callback with new rules on apply', () => {
      WAFManagerModule.WAFManager.prototype.reload.resetHistory()
      const testRules = {
        version: '2.2',
        metadata: { 'rules_version': '1.5.0' },
        rules: [{
          'id': 'test-id',
          'name': 'test-name',
          'tags': {
            'type': 'security_scanner',
            'category': 'attack_attempt',
            'confidence': '1'
          },
          'conditions': []
        }]
      }

      updateAsmDDRules('apply', testRules)

      expect(WAFManagerModule.WAFManager.prototype.reload).to.have.been.calledOnceWithExactly(testRules)
    })

    it('should create new callback with default rules on unapply', () => {
      WAFManagerModule.WAFManager.prototype.reload.resetHistory()
      const testRules = {
        version: '2.2',
        metadata: { 'rules_version': '1.5.0' },
        rules: [{
          'id': 'test-id',
          'name': 'test-name',
          'tags': {
            'type': 'security_scanner',
            'category': 'attack_attempt',
            'confidence': '1'
          },
          'conditions': []
        }]
      }

      updateAsmDDRules('unapply', testRules)

      expect(WAFManagerModule.WAFManager.prototype.reload).to.have.been.calledOnceWithExactly(rules)
    })
  })
})
