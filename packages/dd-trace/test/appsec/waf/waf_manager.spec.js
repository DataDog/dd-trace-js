'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const rules = require('../../../src/appsec/recommended.json')

describe('WAFManager', () => {
  let WAFManager, WAFContextWrapper, DDWAF, log, Reporter

  const knownAddresses = new Set()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses
    DDWAF.prototype.diagnostics = {}
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.createOrUpdateConfig = sinon.stub().returns(true)
    DDWAF.prototype.removeConfig = sinon.stub().returns(true)

    WAFContextWrapper = sinon.stub()
    log = { error: sinon.stub() }
    Reporter = { reportWafInit: sinon.stub() }

    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      './waf_context_wrapper': WAFContextWrapper,
      '@datadog/native-appsec': { DDWAF },
      '../../log': log,
      '../reporter': Reporter,
    })
  })

  describe('getWAFContext', () => {
    it('should construct WAFContextWrapper with knownAddresses', () => {
      const wafManager = new WAFManager({ custom_rules: [] }, {})

      wafManager.getWAFContext({})

      const any = sinon.match.any
      sinon.assert.calledOnceWithMatch(WAFContextWrapper, any, any, any, any, knownAddresses, false)
    })

    it('should skip empty GraphQL resolvers only for the bundled configuration', () => {
      const wafManager = new WAFManager(rules, {})

      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
    })

    it('should preserve the policy of existing request contexts across configuration updates', () => {
      const wafManager = new WAFManager(rules, {})
      const firstRequest = {}
      const firstContext = wafManager.getWAFContext(firstRequest)

      wafManager.updateConfig('custom', { custom_rules: [] })
      wafManager.getWAFContext({})
      assert.strictEqual(WAFContextWrapper.secondCall.args[5], false)
      assert.strictEqual(wafManager.getWAFContext(firstRequest), firstContext)

      wafManager.removeConfig('custom')
      wafManager.getWAFContext({})
      assert.strictEqual(WAFContextWrapper.thirdCall.args[5], true)
    })

    for (const key of ['actions', 'metadata', 'rules_data', 'rules_override', 'exclusions', 'exclusion_data']) {
      it(`should retain the fast path for ${key} updates`, () => {
        const wafManager = new WAFManager(rules, {})

        wafManager.updateConfig('update', { [key]: [] })
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
      })
    }

    it('should recognize an unchanged bundled configuration delivered by remote config', () => {
      const wafManager = new WAFManager(rules, {})

      wafManager.updateConfig('remote', JSON.parse(JSON.stringify(rules)))
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
    })

    it('should disable the fast path when a bundled rule changes', () => {
      const wafManager = new WAFManager(rules, {})
      const updated = JSON.parse(JSON.stringify(rules))
      updated.rules[0].conditions = []

      wafManager.updateConfig('remote', updated)
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
    })

    it('should retain the conservative policy after a failed configuration update', () => {
      const wafManager = new WAFManager({ custom_rules: [] }, {})
      DDWAF.prototype.createOrUpdateConfig.returns(false)

      wafManager.updateConfig(WAFManager.defaultWafConfigPath, rules)
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
    })

    it('should retain the conservative policy after a failed configuration removal', () => {
      const wafManager = new WAFManager(rules, {})
      wafManager.updateConfig('custom', { custom_rules: [] })
      DDWAF.prototype.removeConfig.returns(false)

      wafManager.removeConfig('custom')
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
    })
  })

  describe('GraphQL configuration safety', () => {
    for (const config of [null, [], 'invalid']) {
      it(`should defer invalid configuration ${JSON.stringify(config)} to the native WAF`, () => {
        const wafManager = new WAFManager(rules, {})

        wafManager.updateConfig('invalid', config)
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
      })
    }

    for (const config of [
      { rules: [] },
      { custom_rules: [] },
      { processors: [] },
      { scanners: [] },
      { future_option: undefined },
    ]) {
      it(`should evaluate empty resolvers for an unrecognized ${Object.keys(config)[0]} configuration`, () => {
        const wafManager = new WAFManager(rules, {})

        wafManager.updateConfig('custom', config)
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
      })
    }
  })

  describe('_loadDDWAF', () => {
    it('should log the original error when the native package fails to load', () => {
      const err = new Error('unsupported platform')
      DDWAF.version.throws(err)

      assert.throws(() => new WAFManager({}, {}), err)

      sinon.assert.calledOnceWithExactly(
        log.error,
        '[ASM] AppSec could not load native package. In-app WAF features will not be available.',
        err
      )
      sinon.assert.calledOnceWithExactly(Reporter.reportWafInit, 'unknown', 'unknown')
    })
  })
})
