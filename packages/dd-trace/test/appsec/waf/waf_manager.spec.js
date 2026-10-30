'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const rules = require('../../../src/appsec/recommended.json')
const fieldRules = require('../graphql-field-rules.json')

describe('WAFManager', () => {
  let WAFManager, WAFContextWrapper, DDWAF, log, Reporter

  const knownAddresses = new Set()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses
    DDWAF.prototype.diagnostics = {}
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.createOrUpdateConfig = sinon.stub().callsFake(function () {
      this.knownAddresses = new Set()
      return true
    })
    DDWAF.prototype.removeConfig = sinon.stub().callsFake(function () {
      this.knownAddresses = new Set()
      return true
    })

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
      const wafManager = new WAFManager(fieldRules, {})

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

      wafManager.updateConfig('custom', fieldRules)
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
      const wafManager = new WAFManager(fieldRules, {})
      DDWAF.prototype.createOrUpdateConfig.returns(false)

      wafManager.updateConfig(WAFManager.defaultWafConfigPath, rules)
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
    })

    it('should retain the conservative policy after a failed configuration removal', () => {
      const wafManager = new WAFManager(rules, {})
      wafManager.updateConfig('custom', fieldRules)
      DDWAF.prototype.removeConfig.returns(false)

      wafManager.removeConfig('custom')
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
    })

    for (const operation of ['update', 'remove']) {
      it(`should retain the installed policy when an accepted ${operation} does not publish an instance`, () => {
        const wafManager = new WAFManager(fieldRules, {})
        DDWAF.prototype.createOrUpdateConfig.returns(true)
        DDWAF.prototype.removeConfig.returns(true)

        if (operation === 'update') {
          wafManager.updateConfig(WAFManager.defaultWafConfigPath, { actions: [] })
        } else {
          wafManager.removeConfig(WAFManager.defaultWafConfigPath)
        }
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
      })
    }

    it('should keep the installed fast path after a rejected unsafe update', () => {
      const wafManager = new WAFManager(rules, {})
      DDWAF.prototype.createOrUpdateConfig.returns(false)

      wafManager.updateConfig('custom', fieldRules)
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
    })
  })

  describe('GraphQL configuration safety', () => {
    it('should recognize bundled predicates independently of rule names and order', () => {
      const wafManager = new WAFManager(rules, {})
      const updated = structuredClone(rules)
      for (const rule of updated.rules) rule.name += ' renamed'
      updated.rules.reverse()

      wafManager.updateConfig('remote', updated)
      wafManager.getWAFContext({})

      assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
    })

    for (const rule of [
      null, [], 'invalid', {}, { conditions: [] }, { conditions: null },
      { conditions: [null] },
      { conditions: [{ operator: 'phrase_match', parameters: null }] },
      { conditions: [{ operator: 'phrase_match', parameters: { inputs: [] } }] },
      { conditions: [{ operator: 'phrase_match', parameters: { inputs: [null] } }] },
      { conditions: [{ operator: 'phrase_match', parameters: { inputs: [{}] } }] },
      { conditions: [{ operator: 'phrase_match', parameters: { inputs: [], future_option: true } }] },
      { transformers: null, conditions: [{ operator: 'phrase_match' }] },
    ]) {
      it(`should inspect empty resolvers for an unrecognized rule shape ${JSON.stringify(rule)}`, () => {
        const wafManager = new WAFManager(rules, {})

        wafManager.updateConfig('custom', { custom_rules: [rule] })
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
      })
    }

    for (const operator of ['match_regex', 'phrase_match', 'is_sqli', 'is_xss']) {
      it(`should skip empty resolvers for value-only ${operator} rules`, () => {
        const wafManager = new WAFManager(rules, {})
        const updated = structuredClone(fieldRules)
        updated.rules[0].conditions[0].operator = operator
        updated.rules[0].transformers = ['lowercase', 'values_only']
        updated.rules[0].conditions[0].parameters.inputs[0].transformers = ['url_decode']

        wafManager.updateConfig('custom', updated)
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
      })
    }

    for (const unsafe of [
      { operator: '!match_regex' },
      { operator: 'exists' },
      { operator: 'equals' },
      { operator: 'future_operator' },
      { transformers: ['keys_only'] },
      { transformers: ['future_transformer'] },
      { inputTransformers: ['keys_only'] },
      { inputTransformers: ['future_transformer'] },
      { output: { attributes: { field: { address: 'graphql.server.resolver' } } } },
      { future_option: true },
    ]) {
      it(`should inspect empty resolvers for unsupported rule behavior ${JSON.stringify(unsafe)}`, () => {
        const wafManager = new WAFManager(rules, {})
        const updated = structuredClone(fieldRules)
        const rule = updated.rules[0]
        delete rule.transformers
        if (unsafe.operator) rule.conditions[0].operator = unsafe.operator
        if (unsafe.transformers) rule.transformers = unsafe.transformers
        if (unsafe.inputTransformers) {
          rule.conditions[0].parameters.inputs[0].transformers = unsafe.inputTransformers
        }
        if (unsafe.output) rule.output = unsafe.output
        if (unsafe.future_option) rule.future_option = true
        rule.enabled = false

        wafManager.updateConfig('custom', updated)
        wafManager.updateConfig('override', {
          rules_override: [{ rules_target: [{ rule_id: rule.id }], enabled: true }],
        })
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], false)
      })
    }

    for (const key of ['rules', 'custom_rules']) {
      it(`should skip empty resolvers for empty ${key}`, () => {
        const wafManager = new WAFManager(rules, {})

        wafManager.updateConfig('custom', { [key]: [] })
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
      })
    }

    for (const config of [null, [], 'invalid']) {
      it(`should defer invalid configuration ${JSON.stringify(config)} to the native WAF`, () => {
        const wafManager = new WAFManager(rules, {})

        DDWAF.prototype.createOrUpdateConfig.returns(false)
        wafManager.updateConfig('invalid', config)
        wafManager.getWAFContext({})

        assert.strictEqual(WAFContextWrapper.firstCall.args[5], true)
        sinon.assert.calledOnceWithExactly(DDWAF.prototype.createOrUpdateConfig, config, 'invalid')
      })
    }

    for (const config of [
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
