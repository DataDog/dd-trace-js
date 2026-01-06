'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const blocking = require('../../src/appsec/blocking')
const rules = require('../../src/appsec/recommended.json')
const { loadRules, clearAllRules } = require('../../src/appsec/rule_manager')
const waf = require('../../src/appsec/waf')
const { UNACKNOWLEDGED } = require('../../src/remote_config/apply_states')
const { getConfigFresh } = require('../helpers/config')

describe('AppSec Rule Manager', () => {
  let config

  beforeEach(() => {
    clearAllRules()
    config = getConfigFresh()

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

      sinon.assert.calledOnceWithExactly(waf.init, rules, config.appsec)
    })

    it('should throw if null/undefined are passed', () => {
      // TODO: fix the exception thrown in the waf or catch it in rule_manager?
      config.appsec.rules = './not/existing/file.json'
      assert.throws(() => { loadRules(config.appsec) })

      config.appsec.rules = './bad-formatted-rules.json'
      assert.throws(() => { loadRules(config.appsec) })
    })

    it('should call updateBlockingConfiguration with proper params', () => {
      const rulesPath = path.join(__dirname, './blocking-actions-rules.json')
      const testRules = JSON.parse(fs.readFileSync(rulesPath))

      config.appsec.rules = rulesPath

      loadRules(config.appsec)

      sinon.assert.calledOnceWithExactly(waf.init, testRules, config.appsec)
      sinon.assert.calledOnceWithExactly(blocking.setDefaultBlockingActionParameters, testRules.actions)
    })
  })

  describe('clearAllRules', () => {
    it('should call clear method on all applied rules', () => {
      loadRules(config.appsec)
      sinon.assert.calledOnce(waf.init)

      blocking.setDefaultBlockingActionParameters.resetHistory()

      clearAllRules()
      sinon.assert.calledOnce(waf.destroy)
      sinon.assert.calledOnceWithExactly(blocking.setDefaultBlockingActionParameters, undefined)
    })
  })

  describe('updateWafFromRC', () => {
    function createTransaction (changes) {
      return {
        ...changes,
        changes,
        ack: sinon.spy(),
        error: sinon.spy()
      }
    }

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
              id: 'custom_rule1',
              name: 'custom_rule1',
              tags: {
                tag1: 'flow1',
                type: 'type1'
              },
              conditions: [
                {
                  operator: 'match_regex',
                  parameters: {
                    inputs: [
                      {
                        address: 'server.request.headers.no_cookies'
                      },
                      {
                        address: 'server.request.query'
                      }
                    ],
                    regex: 'custom_rule1'
                  }
                }
              ]
            }]
          },
          apply_state: UNACKNOWLEDGED
        }]
      }
    }

    let RuleManager
    let reportWafUpdate
    let setDefaultBlockingActionParameters

    beforeEach(() => {
      reportWafUpdate = sinon.stub()
      setDefaultBlockingActionParameters = sinon.stub()

      RuleManager = proxyquire('../../src/appsec/rule_manager', {
        './reporter': {
          reportWafUpdate
        },
        './blocking': {
          setDefaultBlockingActionParameters
        }
      })

      waf.init.callThrough()

      sinon.stub(waf, 'updateConfig')
      sinon.stub(waf, 'removeConfig')

      RuleManager.clearAllRules()

      config = getConfigFresh()
      RuleManager.loadRules(config.appsec)
      sinon.resetHistory()
    })

    it('should not apply configs from non ASM products', () => {
      const changes = {
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

      const transaction = createTransaction(changes)
      RuleManager.updateWafFromRC(transaction)

      sinon.assert.notCalled(transaction.ack)
      sinon.assert.notCalled(transaction.error)

      sinon.assert.notCalled(waf.updateConfig)
      sinon.assert.notCalled(waf.removeConfig)

      assert.deepStrictEqual(waf.wafManager.ddwaf.configPaths, [waf.wafManager.constructor.defaultWafConfigPath])
    })

    it('should apply configs from ASM products', () => {
      waf.updateConfig.callThrough()
      waf.removeConfig.callThrough()

      const changes = getRcConfigs()
      const transaction = createTransaction(changes)

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledOnceWithExactly(waf.removeConfig, changes.toUnapply[0].path)
      sinon.assert.calledTwice(waf.updateConfig)
      sinon.assert.calledWith(
        waf.updateConfig,
        changes.toApply[0].product,
        changes.toApply[0].id,
        changes.toApply[0].path,
        changes.toApply[0].file
      )
      sinon.assert.calledWith(
        waf.updateConfig,
        changes.toModify[0].product,
        changes.toModify[0].id,
        changes.toModify[0].path,
        changes.toModify[0].file
      )

      assert.strictEqual(waf.wafManager.ddwaf.configPaths.length, 3)
      assert.deepStrictEqual(waf.wafManager.ddwaf.configPaths.sort(), [
        waf.wafManager.constructor.defaultWafConfigPath,
        changes.toApply[0].path,
        changes.toModify[0].path
      ].sort())

      // Should ack for each ASM product config.
      sinon.assert.calledWithExactly(transaction.ack, changes.toUnapply[0].path)
      sinon.assert.calledWithExactly(transaction.ack, changes.toApply[0].path)
      sinon.assert.calledWithExactly(transaction.ack, changes.toModify[0].path)
      sinon.assert.notCalled(transaction.error)
    })

    it('should ack on successful apply', () => {
      waf.updateConfig.callThrough()
      waf.removeConfig.callThrough()

      const changes = getRcConfigs()
      const transaction = createTransaction(changes)

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledWithExactly(transaction.ack, changes.toUnapply[0].path)
      sinon.assert.calledWithExactly(transaction.ack, changes.toApply[0].path)
      sinon.assert.calledWithExactly(transaction.ack, changes.toModify[0].path)
      sinon.assert.notCalled(transaction.error)
    })

    it('should call transaction.error on failed config remove', () => {
      const removeConfigError = new Error('Error remove config')
      waf.removeConfig.throws(removeConfigError)

      const changes = { toUnapply: getRcConfigs().toUnapply, toApply: [], toModify: [] }
      const transaction = createTransaction(changes)

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledWithMatch(transaction.error, changes.toUnapply[0].path, removeConfigError)
    })

    it('should call transaction.error on failed config update', () => {
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
      const changes = { toUnapply: [], toApply, toModify }
      const transaction = createTransaction(changes)

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledWithExactly(transaction.error, toApply[0].path, JSON.stringify(expectedApplyError))
      sinon.assert.calledWithExactly(transaction.error, toModify[0].path, JSON.stringify(expectedApplyError))
    })

    it('should report successful waf update', () => {
      const transaction = createTransaction(getRcConfigs())

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledOnceWithExactly(
        reportWafUpdate,
        waf.wafManager.ddwafVersion,
        waf.wafManager.rulesVersion,
        true
      )
    })

    it('should report failed waf update', () => {
      waf.updateConfig.throws(new waf.WafUpdateError({ error: 'Update failed' }))

      const transaction = createTransaction(getRcConfigs())

      RuleManager.updateWafFromRC(transaction)

      sinon.assert.calledOnceWithExactly(
        reportWafUpdate,
        waf.wafManager.ddwafVersion,
        waf.wafManager.rulesVersion,
        false
      )
    })

    describe('ASM_DD Fallback', () => {
      it('should fallback to default ruleset if no ASM_DD has been loaded successfully', () => {
        waf.updateConfig.callThrough()
        waf.removeConfig.callThrough()

        const changes = {
          toApply: [
            {
              id: 'asm_dd.test.failed',
              product: 'ASM_DD',
              path: 'test/rule_manager/updateWafFromRC/ASM_DD/01',
              file: { rules: [{ name: 'rule_with_missing_id' }] }
            }
          ],
          toModify: [],
          toUnapply: []
        }

        const transaction = createTransaction(changes)
        RuleManager.updateWafFromRC(transaction)

        sinon.assert.called(transaction.error)

        assert.deepStrictEqual(waf.wafManager.ddwaf.configPaths, [waf.wafManager.constructor.defaultWafConfigPath])
      })
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

        RuleManager.updateWafFromRC(createTransaction({ toUnapply: [], toApply, toModify: [] }))

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

        RuleManager.updateWafFromRC(createTransaction({ toUnapply: [], toApply, toModify: [] }))

        sinon.assert.calledOnceWithExactly(setDefaultBlockingActionParameters, asm.actions)
        sinon.resetHistory()

        const toUnapply = [
          {
            product: 'ASM',
            id: '1'
          }
        ]

        RuleManager.updateWafFromRC(createTransaction({ toUnapply, toApply: [], toModify: [] }))

        sinon.assert.calledOnceWithExactly(setDefaultBlockingActionParameters, [])
      })
    })
  })
})
