'use strict'

const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const { loadRules, clearAllRules } = require('../../src/appsec/rule_manager')
const Config = require('../../src/config')
const { ACKNOWLEDGED, UNACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')

const rules = require('../../src/appsec/recommended.json')
const waf = require('../../src/appsec/waf')
const blocking = require('../../src/appsec/blocking')

describe('AppSec Rule Manager', () => {
  let config

  beforeEach(() => {
    clearAllRules()
    config = new Config()

    sinon.stub(waf, 'init')
    sinon.stub(waf, 'destroy')

    sinon.stub(blocking, 'setDefaultBlockingActionParameters')
  })

  afterEach(() => {
    sinon.restore()
    clearAllRules()
  })

  describe('loadRules', () => {
    it('should call waf init with proper params', () => {
      loadRules(config.appsec)

      expect(waf.init).to.have.been.calledOnceWithExactly(rules, config.appsec)
    })

    it('should throw if null/undefined are passed', () => {
      // TODO: fix the exception thrown in the waf or catch it in rule_manager?
      config.appsec.rules = './not/existing/file.json'
      expect(() => { loadRules(config.appsec) }).to.throw()

      config.appsec.rules = './bad-formatted-rules.json'
      expect(() => { loadRules(config.appsec) }).to.throw()
    })

    it('should call updateBlockingConfiguration with proper params', () => {
      const rulesPath = path.join(__dirname, './blocking-actions-rules.json')
      const testRules = JSON.parse(fs.readFileSync(rulesPath))

      config.appsec.rules = rulesPath

      loadRules(config.appsec)

      expect(waf.init).to.have.been.calledOnceWithExactly(testRules, config.appsec)
      expect(blocking.setDefaultBlockingActionParameters).to.have.been.calledOnceWithExactly(testRules.actions)
    })
  })

  describe('clearAllRules', () => {
    it('should call clear method on all applied rules', () => {
      loadRules(config.appsec)
      expect(waf.init).to.have.been.calledOnce

      blocking.setDefaultBlockingActionParameters.resetHistory()

      clearAllRules()
      expect(waf.destroy).to.have.been.calledOnce
      expect(blocking.setDefaultBlockingActionParameters).to.have.been.calledOnceWithExactly(undefined)
    })
  })

  describe('updateWafFromRC', () => {
    function getRcConfigs () {
      return {
        toUnapply: [{
          id: 'test.toUnapply',
          product: 'ASM_DD',
          path: 'test/rule_manager/updateWafFromRC/ASM_DD/01',
          file: {},
          apply_state: UNACKNOWLEDGED
        }],
        toModify: [{
          id: 'test.toModify',
          product: 'ASM_DATA',
          path: 'test/rule_manager/updateWafFromRC/ASM_DATA/01',
          file: {
            rules_data: [{
              data: [
                { value: '1.2.3.4' }
              ],
              id: 'blocked_ips',
              type: 'data_with_expiration'
            }]
          },
          apply_state: UNACKNOWLEDGED
        }],
        toApply: [{
          id: 'test.toApply',
          product: 'ASM',
          path: 'test/rule_manager/updateWafFromRC/ASM/01',
          file: {
            exclusions: [{
              ekey: 'eValue'
            }],
            rules_override: [{
              roKey: 'roValue'
            }],
            custom_rules: [{
              piKey: 'piValue'
            }]
          },
          apply_state: UNACKNOWLEDGED
        }]
      }
    }

    let RuleManager
    let reportSuccessfulWafUpdate, reportWafUpdate
    let setDefaultBlockingActionParameters

    beforeEach(() => {
      reportWafUpdate = sinon.stub()
      reportSuccessfulWafUpdate = sinon.stub()
      setDefaultBlockingActionParameters = sinon.stub()

      RuleManager = proxyquire.noCallThru()('../src/appsec/rule_manager', {
        './reporter': {
          reportWafUpdate,
          reportSuccessfulWafUpdate
        },
        './blocking': {
          setDefaultBlockingActionParameters
        }
      })

      waf.init.callThrough()

      sinon.stub(waf, 'updateConfig')
      sinon.stub(waf, 'removeConfig')

      RuleManager.clearAllRules()
      config = new Config()
      RuleManager.loadRules(config.appsec)
      sinon.resetHistory()
    })

    it('should not apply configs from non ASM products', () => {
      const rcConfigsForNonAsmProducts = {
        toUnapply: [{
          id: 'test.toUnapply',
          product: 'NON_ASM_PRODUCT',
          path: 'test/rule_manager/updateWafFromRC/NON_ASM_PRODUCT/01',
          file: {},
          apply_state: UNACKNOWLEDGED
        }],
        toModify: [{
          id: 'test.toModify',
          product: 'NON_ASM_PRODUCT',
          path: 'test/rule_manager/updateWafFromRC/NON_ASM_PRODUCT/02',
          file: {},
          apply_state: UNACKNOWLEDGED
        }],
        toApply: [{
          id: 'test.toApply',
          product: 'NON_ASM_PRODUCT',
          path: 'test/rule_manager/updateWafFromRC/NON_ASM_PRODUCT/03',
          file: {},
          apply_state: UNACKNOWLEDGED
        }]
      }

      assert.doesNotThrow(() => {
        RuleManager.updateWafFromRC(rcConfigsForNonAsmProducts)
      })

      sinon.assert.notCalled(waf.updateConfig)
      sinon.assert.notCalled(waf.removeConfig)
      assert.strictEqual(rcConfigsForNonAsmProducts.toUnapply[0].apply_state, UNACKNOWLEDGED)
      assert.notProperty(rcConfigsForNonAsmProducts.toUnapply[0], 'apply_error')
      assert.strictEqual(rcConfigsForNonAsmProducts.toModify[0].apply_state, UNACKNOWLEDGED)
      assert.notProperty(rcConfigsForNonAsmProducts.toModify[0], 'apply_error')
      assert.strictEqual(rcConfigsForNonAsmProducts.toApply[0].apply_state, UNACKNOWLEDGED)
      assert.notProperty(rcConfigsForNonAsmProducts.toApply[0], 'apply_error')
    })

    it('should apply configs from ASM products', () => {
      const rcConfigs = getRcConfigs()

      RuleManager.updateWafFromRC(rcConfigs)

      sinon.assert.calledOnceWithExactly(waf.removeConfig, rcConfigs.toUnapply[0].path)
      sinon.assert.calledTwice(waf.updateConfig)
      sinon.assert.calledWith(
        waf.updateConfig,
        rcConfigs.toApply[0].path,
        rcConfigs.toApply[0].file
      )
      sinon.assert.calledWith(
        waf.updateConfig,
        rcConfigs.toModify[0].path,
        rcConfigs.toModify[0].file
      )
    })

    it('should update apply_state and apply_error on successful apply', () => {
      waf.updateConfig.returns({})

      const rcConfigs = getRcConfigs()

      RuleManager.updateWafFromRC(rcConfigs)

      assert.strictEqual(rcConfigs.toUnapply[0].apply_state, ACKNOWLEDGED)
      assert.notProperty(rcConfigs.toUnapply[0], 'apply_error')
      assert.strictEqual(rcConfigs.toModify[0].apply_state, ACKNOWLEDGED)
      assert.notProperty(rcConfigs.toModify[0], 'apply_error')
      assert.strictEqual(rcConfigs.toApply[0].apply_state, ACKNOWLEDGED)
      assert.notProperty(rcConfigs.toApply[0], 'apply_error')
    })

    it('should update apply_state and apply_error on failed config remove', () => {
      const removeConfigError = new Error('Error remove config')
      waf.removeConfig.throws(removeConfigError)

      const { toUnapply } = getRcConfigs()

      RuleManager.updateWafFromRC({ toUnapply, toApply: [], toModify: [] })

      assert.strictEqual(toUnapply[0].apply_state, ERROR)
      assert.strictEqual(toUnapply[0].apply_error, removeConfigError.toString())
    })

    it('should update apply_state and apply_error on failed config update', () => {
      const diagnostics = {
        rules: {
          loaded: [],
          failed: ['blk-001-001'],
          skipped: [],
          errors: {
            'missing key operator': [
              'blk-001-001'
            ]
          },
          warnings: {
            'invalid tag': [
              'blk-001-001'
            ]
          }
        },
        processors: {
          loaded: ['http-endpoint-fingerprint'],
          failed: [],
          skipped: [],
          errors: {
            'missing mapping definition': [
              'http-endpoint-fingerprint'
            ]
          },
          warnings: {
            'no mappings defined': [
              'http-endpoint-fingerprint'
            ]
          }
        },
        scanners: {
          error: 'Fatal error'
        }
      }

      const expectedApplyError = {
        rules: {
          errors: diagnostics.rules.errors
        },
        processors: {
          errors: diagnostics.processors.errors
        },
        scanners: {
          error: diagnostics.scanners.error
        }
      }

      waf.updateConfig.throws(new waf.WafUpdateError(diagnostics))

      const { toModify, toApply } = getRcConfigs()

      RuleManager.updateWafFromRC({ toUnapply: [], toApply, toModify })

      assert.strictEqual(toApply[0].apply_state, ERROR)
      assert.strictEqual(toApply[0].apply_error, JSON.stringify(expectedApplyError))
      assert.strictEqual(toModify[0].apply_state, ERROR)
      assert.strictEqual(toModify[0].apply_error, JSON.stringify(expectedApplyError))
    })

    it('should report successful waf update', () => {
      waf.updateConfig.returns({})

      const rcConfigs = getRcConfigs()

      RuleManager.updateWafFromRC(rcConfigs)

      sinon.assert.calledOnceWithExactly(
        reportWafUpdate,
        waf.wafManager.ddwafVersion,
        waf.wafManager.rulesVersion,
        true
      )
      sinon.assert.calledTwice(reportSuccessfulWafUpdate)
      sinon.assert.calledWith(reportSuccessfulWafUpdate, rcConfigs.toModify[0].product, rcConfigs.toModify[0].id, {})
      sinon.assert.calledWith(reportSuccessfulWafUpdate, rcConfigs.toApply[0].product, rcConfigs.toApply[0].id, {})
    })

    it('should report waf update', () => {
      waf.updateConfig.onFirstCall().throws(new waf.WafUpdateError({ error: 'Waf update error' }))
      waf.updateConfig.onSecondCall().returns({})

      const rcConfigs = getRcConfigs()

      RuleManager.updateWafFromRC(rcConfigs)

      sinon.assert.calledOnceWithExactly(
        reportWafUpdate,
        waf.wafManager.ddwafVersion,
        waf.wafManager.rulesVersion,
        false
      )
    })

    describe('ASM', () => {
      it('should apply blocking actions', () => {
        waf.updateConfig.returns({})

        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: {
              actions: [
                {
                  id: 'notblock',
                  parameters: {
                    location: '/notfound',
                    status_code: 404
                  }
                }
              ]
            }
          },
          {
            product: 'ASM',
            id: '2',
            file: {
              actions: [
                {
                  id: 'block',
                  parameters: {
                    location: '/redirected',
                    status_code: 302
                  }
                }
              ]
            }
          }
        ]

        RuleManager.updateWafFromRC({ toUnapply: [], toApply, toModify: [] })

        const expectedActions = [
          {
            id: 'notblock',
            parameters: {
              location: '/notfound',
              status_code: 404
            }
          },
          {
            id: 'block',
            parameters: {
              location: '/redirected',
              status_code: 302
            }
          }
        ]

        sinon.assert.calledOnceWithExactly(setDefaultBlockingActionParameters, expectedActions)
      })

      it('should unapply blocking actions', () => {
        waf.updateConfig.returns({})

        const asm = {
          actions: [
            {
              id: 'block',
              otherParam: 'other'
            },
            {
              id: 'otherId',
              moreParams: 'more'
            }
          ]
        }
        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          }
        ]

        RuleManager.updateWafFromRC({ toUnapply: [], toApply, toModify: [] })

        sinon.assert.calledOnceWithExactly(setDefaultBlockingActionParameters, asm.actions)
        sinon.resetHistory()

        const toUnapply = [
          {
            product: 'ASM',
            id: '1'
          }
        ]

        RuleManager.updateWafFromRC({ toUnapply, toApply: [], toModify: [] })

        sinon.assert.calledOnceWithExactly(setDefaultBlockingActionParameters, [])
      })
    })
  })
})
