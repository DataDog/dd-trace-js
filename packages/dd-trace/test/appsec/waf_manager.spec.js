'use strict'

const proxyquire = require('proxyquire')
const Config = require('../../src/config')
const rules = require('../../src/appsec/recommended.json')
const Reporter = require('../../src/appsec/reporter')
const addresses = require('../../src/appsec/addresses')
const web = require('../../src/plugins/util/web')

describe('WAF Manager', () => {
  let WAFManagerModule
  let DDWAF
  let config
  let webContext

  beforeEach(() => {
    config = new Config()

    DDWAF = sinon.stub()
    DDWAF.prototype.constructor.version = sinon.stub()
    DDWAF.prototype.dispose = sinon.stub()
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.updateRuleData = sinon.stub()
    DDWAF.prototype.rulesInfo = {
      loaded: true, failed: 0
    }

    WAFManagerModule = proxyquire('../../src/appsec/waf_manager', {
      '@datadog/native-appsec': { DDWAF }
    })
    WAFManagerModule.destroy()

    sinon.stub(Reporter.metricsQueue, 'set')
    sinon.stub(Reporter, 'reportMetrics')
    sinon.stub(Reporter, 'reportAttack')

    webContext = {}
    sinon.stub(web, 'getContext').returns(webContext)
  })
  afterEach(() => {
    sinon.restore()
    WAFManagerModule.destroy()
  })

  describe('init', () => {
    it('should initialize the manager', () => {
      expect(WAFManagerModule.wafManager).to.be.null
      WAFManagerModule.init(rules, config.appsec)

      expect(WAFManagerModule.wafManager).not.to.be.null
      expect(WAFManagerModule.wafManager.ddwaf).to.be.instanceof(DDWAF)
    })

    it('should set init metrics without error', () => {
      DDWAF.prototype.constructor.version.returns('1.2.3')

      WAFManagerModule.init(rules, config.appsec)

      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.waf.version', '1.2.3')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', true)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 0)
      expect(Reporter.metricsQueue.set).not.to.been.calledWith('_dd.appsec.event_rules.errors')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })

    it('should set init metrics with errors', () => {
      DDWAF.prototype.constructor.version.returns('2.3.4')
      DDWAF.prototype.rulesInfo = {
        loaded: false, failed: 2, errors: ['error1', 'error2']
      }

      WAFManagerModule.init(rules, config.appsec)

      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.waf.version', '2.3.4')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', false)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 2)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.errors',
        '["error1","error2"]')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })

    it('should accept some addresses by default', () => {
      const newRules = {
        rules: []
      }
      WAFManagerModule.init(newRules, config.appsec)
      expect(WAFManagerModule.wafManager.acceptedAddresses).to.have.all.keys(
        addresses.HTTP_INCOMING_HEADERS,
        addresses.HTTP_INCOMING_ENDPOINT,
        addresses.HTTP_INCOMING_RESPONSE_HEADERS,
        addresses.HTTP_INCOMING_REMOTE_IP
      )
    })
  })

  describe('wafManager.reload', () => {
    beforeEach(() => {
      WAFManagerModule.init(rules, config.appsec)
      Reporter.metricsQueue.set.resetHistory()
    })
    it('should create new instance of ddwaf', () => {
      const previousDdwaf = WAFManagerModule.wafManager.ddwaf
      expect(previousDdwaf).to.be.instanceof(DDWAF)

      WAFManagerModule.wafManager.reload(rules)

      expect(WAFManagerModule.wafManager.ddwaf).to.be.instanceof(DDWAF)
      expect(WAFManagerModule.wafManager.ddwaf).not.to.be.equal(previousDdwaf)
    })

    it('should dispose old ddwaf', () => {
      DDWAF.prototype.dispose.callsFake(function () {
        this.disposed = true
      })
      const previousDdwaf = WAFManagerModule.wafManager.ddwaf

      WAFManagerModule.wafManager.reload(rules)

      expect(previousDdwaf.disposed).to.be.true
      expect(WAFManagerModule.wafManager.ddwaf).not.to.be.true
    })

    it('should set init metrics without error', () => {
      DDWAF.prototype.constructor.version.returns('1.2.3')

      WAFManagerModule.wafManager.reload(rules)

      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.waf.version', '1.2.3')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', true)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 0)
      expect(Reporter.metricsQueue.set).not.to.been.calledWith('_dd.appsec.event_rules.errors')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })

    it('should set init metrics with errors', () => {
      DDWAF.prototype.constructor.version.returns('2.3.4')
      DDWAF.prototype.rulesInfo = {
        loaded: false, failed: 2, errors: ['error1', 'error2']
      }

      WAFManagerModule.wafManager.reload(rules)

      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.waf.version', '2.3.4')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', false)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 2)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.errors',
        '["error1","error2"]')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })
  })

  describe('wafManager.createDDWAFContext', () => {
    beforeEach(() => {
      WAFManagerModule.init(rules, config.appsec)
    })

    it('should call ddwaf.createContext', () => {
      WAFManagerModule.wafManager.createDDWAFContext()
      expect(WAFManagerModule.wafManager.ddwaf.createContext).to.been.calledOnce
    })
  })

  describe('wafManager.updateRuleData', () => {
    beforeEach(() => {
      WAFManagerModule.init(rules, config.appsec)
    })

    it('should call ddwaf.updateRuleData', () => {
      const ruleData = [
        {
          id: 'blocked_users',
          type: 'data_with_expiration',
          data: [
            {
              expiration: 9999999999,
              value: 'user1'
            }
          ]
        }
      ]

      WAFManagerModule.wafManager.updateRuleData(ruleData)

      expect(DDWAF.prototype.updateRuleData).to.be.calledOnceWithExactly(ruleData)
    })
  })

  describe('WAFContextWrapper', () => {
    let ddwafContext, wafContextWrapper

    beforeEach(() => {
      WAFManagerModule.init(rules, config.appsec)

      ddwafContext = {
        dispose: sinon.stub(),
        run: sinon.stub(),
        disposed: false
      }
      DDWAF.prototype.createContext.returns(ddwafContext)

      wafContextWrapper = WAFManagerModule.wafManager.createDDWAFContext()
    })

    describe('dispose', () => {
      it('should call ddwafContext.dispose', () => {
        const wafContextWrapper = WAFManagerModule.wafManager.createDDWAFContext()
        wafContextWrapper.dispose()
        expect(ddwafContext.dispose).to.be.calledOnce
      })

      it('should not call ddwafContext.dispose when it is already disposed', () => {
        ddwafContext.disposed = true
        const wafContextWrapper = WAFManagerModule.wafManager.createDDWAFContext()
        wafContextWrapper.dispose()
        expect(ddwafContext.dispose).not.to.be.called
      })
    })

    describe('run', () => {
      it('should not call ddwafContext.run without params', () => {
        wafContextWrapper.run()
        expect(ddwafContext.run).not.to.be.called
      })

      it('should not call ddwafContext.run with invalid params', () => {
        wafContextWrapper.run({
          'invalid_address': 'value'
        })
        expect(ddwafContext.run).not.to.be.called
      })

      it('should call ddwafContext.run with params', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })

        wafContextWrapper.run({
          'server.request.headers.no_cookies': { 'header': 'value' },
          'server.request.uri.raw': 'https://testurl'
        })

        expect(ddwafContext.run).to.be.calledOnceWithExactly({
          'server.request.headers.no_cookies': { 'header': 'value' },
          'server.request.uri.raw': 'https://testurl'
        }, config.appsec.wafTimeout)
      })

      it('should call ddwafContext.run with filtered params', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })

        wafContextWrapper.run({
          'server.request.headers.no_cookies': { 'header2': 'value2' },
          'invalidaddress': 'invalid-value',
          'server.request.uri.raw': 'https://othertesturl'
        })

        expect(ddwafContext.run).to.be.calledOnceWithExactly({
          'server.request.headers.no_cookies': { 'header2': 'value2' },
          'server.request.uri.raw': 'https://othertesturl'
        }, config.appsec.wafTimeout)
      })

      it('should report attack when ddwafContext returns data', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, data: 'ATTACK DATA' })
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).to.be.calledOnceWithExactly('ATTACK DATA', params)
      })

      it('should not report attack when ddwafContext does not return data', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should not report attack when ddwafContext returns empty data', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, data: '[]' })
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should return the actions', () => {
        const actions = ['block']
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, data: '[]', actions: actions })

        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        const result = wafContextWrapper.run(params)

        expect(result).to.be.equals(actions)
      })

      it('should maintain the addresses when the ddwaf is reloaded', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })
        const newRules = {
          rules: [
            {
              'id': '001',
              'name': 'test',
              'tags': {
                'type': 'security_scanner',
                'category': 'attack_attempt'
              },
              'conditions': [
                {
                  'parameters': {
                    'inputs': [
                      {
                        'address': 'server.request.query',
                        'key_path': [
                          'key'
                        ]
                      }
                    ],
                    'regex': 'hello'
                  },
                  'operator': 'match_regex'
                }
              ],
              'transformers': []
            }
          ]
        }
        WAFManagerModule.wafManager.reload(newRules)

        const params = {
          'server.response.status': 200,
          'server.request.query': { 'paramname': 'paramvalue' }
        }

        wafContextWrapper.run(params)

        expect(ddwafContext.run).to.be.calledOnceWithExactly({
          'server.response.status': 200,
          'server.request.query': { 'paramname': 'paramvalue' }
        }, config.appsec.wafTimeout)
      })

      it('should ignore the addresses in the old waf in reloaded context', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })
        const newRules = {
          rules: [
            {
              'id': '001',
              'name': 'test',
              'tags': {
                'type': 'security_scanner',
                'category': 'attack_attempt'
              },
              'conditions': [
                {
                  'parameters': {
                    'inputs': [
                      {
                        'address': 'server.request.query',
                        'key_path': [
                          'key'
                        ]
                      }
                    ],
                    'regex': 'hello'
                  },
                  'operator': 'match_regex'
                }
              ],
              'transformers': []
            }
          ]
        }
        WAFManagerModule.wafManager.reload(newRules)
        const newWafContext = WAFManagerModule.wafManager.createDDWAFContext()
        const params = {
          'server.response.status': 200,
          'server.request.query': { 'paramname': 'paramvalue' }
        }

        newWafContext.run(params)

        expect(ddwafContext.run).to.be.calledOnceWithExactly({
          'server.request.query': { 'paramname': 'paramvalue' }
        }, config.appsec.wafTimeout)
      })
    })
  })
})
