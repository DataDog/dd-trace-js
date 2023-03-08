'use strict'

const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const rules = require('../../../src/appsec/recommended.json')
const Reporter = require('../../../src/appsec/reporter')
const addresses = require('../../../src/appsec/addresses')
const web = require('../../../src/plugins/util/web')

describe('WAF Manager', () => {
  let waf, WAFManager
  let DDWAF
  let config
  let webContext

  beforeEach(() => {
    config = new Config()

    DDWAF = sinon.stub()
    DDWAF.prototype.constructor.version = sinon.stub()
    DDWAF.prototype.dispose = sinon.stub()
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.update = sinon.stub()
    DDWAF.prototype.rulesInfo = {
      loaded: true, failed: 0
    }

    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      '@datadog/native-appsec': { DDWAF }
    })
    waf = proxyquire('../../../src/appsec/waf', {
      './waf_manager': WAFManager
    })
    waf.destroy()

    sinon.stub(Reporter.metricsQueue, 'set')
    sinon.stub(Reporter, 'reportMetrics')
    sinon.stub(Reporter, 'reportAttack')

    webContext = {}
    sinon.stub(web, 'getContext').returns(webContext)
  })
  afterEach(() => {
    sinon.restore()
    waf.destroy()
  })

  describe('init', () => {
    it('should initialize the manager', () => {
      expect(waf.wafManager).to.be.null
      waf.init(rules, config.appsec)

      expect(waf.wafManager).not.to.be.null
      expect(waf.wafManager.ddwaf).to.be.instanceof(DDWAF)
    })

    it('should set init metrics without error', () => {
      DDWAF.prototype.constructor.version.returns('1.2.3')

      waf.init(rules, config.appsec)

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

      waf.init(rules, config.appsec)

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
      waf.init(newRules, config.appsec)
      expect(waf.wafManager.acceptedAddresses).to.have.all.keys(
        addresses.HTTP_INCOMING_HEADERS,
        addresses.HTTP_INCOMING_RESPONSE_HEADERS
      )
    })
  })

  describe('wafManager.reload', () => {
    beforeEach(() => {
      waf.init(rules, config.appsec)
      Reporter.metricsQueue.set.resetHistory()
    })
    it('should create new instance of ddwaf', () => {
      const previousDdwaf = waf.wafManager.ddwaf
      expect(previousDdwaf).to.be.instanceof(DDWAF)

      waf.wafManager.reload(rules)

      expect(waf.wafManager.ddwaf).to.be.instanceof(DDWAF)
      expect(waf.wafManager.ddwaf).not.to.be.equal(previousDdwaf)
    })

    it('should dispose old ddwaf', () => {
      DDWAF.prototype.dispose.callsFake(function () {
        this.disposed = true
      })
      const previousDdwaf = waf.wafManager.ddwaf

      waf.wafManager.reload(rules)

      expect(previousDdwaf.disposed).to.be.true
      expect(waf.wafManager.ddwaf).not.to.be.true
    })

    it('should set init metrics without error', () => {
      DDWAF.prototype.constructor.version.returns('1.2.3')

      waf.wafManager.reload(rules)

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

      waf.wafManager.reload(rules)

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
      waf.init(rules, config.appsec)
    })

    it('should call ddwaf.createContext', () => {
      waf.wafManager.createDDWAFContext()
      expect(waf.wafManager.ddwaf.createContext).to.been.calledOnce
    })
  })

  describe('wafManager.update', () => {
    beforeEach(() => {
      waf.init(rules, config.appsec)
    })

    it('should call ddwaf.update', () => {
      const rules = {
        'rules_data': [
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
      }

      waf.wafManager.update(rules)

      expect(DDWAF.prototype.update).to.be.calledOnceWithExactly(rules)
    })
  })

  describe('WAFContextWrapper', () => {
    let ddwafContext, wafContextWrapper

    beforeEach(() => {
      waf.init(rules, config.appsec)

      ddwafContext = {
        dispose: sinon.stub(),
        run: sinon.stub(),
        disposed: false
      }
      DDWAF.prototype.createContext.returns(ddwafContext)

      wafContextWrapper = waf.wafManager.createDDWAFContext()
    })

    describe('dispose', () => {
      it('should call ddwafContext.dispose', () => {
        const wafContextWrapper = waf.wafManager.createDDWAFContext()
        wafContextWrapper.dispose()
        expect(ddwafContext.dispose).to.be.calledOnce
      })

      it('should not call ddwafContext.dispose when it is already disposed', () => {
        ddwafContext.disposed = true
        const wafContextWrapper = waf.wafManager.createDDWAFContext()
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
        waf.wafManager.reload(newRules)

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
        waf.wafManager.reload(newRules)
        const newWafContext = waf.wafManager.createDDWAFContext()
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
