'use strict'

const { applyRules, clearAllRules } = require('../../src/appsec/rule_manager')
const callbacks = require('../../src/appsec/callbacks')
const Gateway = require('../../src/appsec/gateway/engine')

const rules = [{ a: 'thatsarule' }, { b: 'thatsanotherone' }]

describe('AppSec Rule Manager', () => {
  let FakeDDWAF

  beforeEach(() => {
    FakeDDWAF = sinon.spy()

    FakeDDWAF.prototype.clear = sinon.spy()

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
})
