'use strict'

const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const rules = require('../../../src/appsec/recommended.json')
const Reporter = require('../../../src/appsec/reporter')
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
    DDWAF.prototype.diagnostics = {
      ruleset_version: '1.0.0',
      rules: {
        loaded: ['rule_1'], failed: []
      }
    }
    DDWAF.prototype.requiredAddresses = new Map([
      ['server.request.headers.no_cookies', { 'header': 'value' }],
      ['server.request.uri.raw', 'https://testurl']
    ])

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
    sinon.stub(Reporter, 'reportWafUpdate')

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
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', 1)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 0)
      expect(Reporter.metricsQueue.set).not.to.been.calledWith('_dd.appsec.event_rules.errors')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })

    it('should set init metrics with errors', () => {
      DDWAF.prototype.constructor.version.returns('2.3.4')
      DDWAF.prototype.diagnostics = {
        rules: {
          loaded: ['rule_1'],
          failed: ['rule_2', 'rule_3'],
          errors: {
            'error_1': ['invalid_1'],
            'error_2': ['invalid_2', 'invalid_3']
          }
        }
      }

      waf.init(rules, config.appsec)

      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.waf.version', '2.3.4')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.loaded', 1)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.error_count', 2)
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('_dd.appsec.event_rules.errors',
        '{"error_1":["invalid_1"],"error_2":["invalid_2","invalid_3"]}')
      expect(Reporter.metricsQueue.set).to.been.calledWithExactly('manual.keep', 'true')
    })
  })

  describe('wafManager.createDDWAFContext', () => {
    beforeEach(() => {
      DDWAF.prototype.constructor.version.returns('4.5.6')
      waf.init(rules, config.appsec)
    })

    it('should call ddwaf.createContext', () => {
      const req = {}
      waf.wafManager.getWAFContext(req)
      expect(waf.wafManager.ddwaf.createContext).to.have.been.calledOnce
    })

    it('should pass waf version when invoking ddwaf.createContext', () => {
      const req = {}
      const context = waf.wafManager.getWAFContext(req)
      expect(context.wafVersion).to.be.eq('4.5.6')
    })
  })

  describe('wafManager.update', () => {
    const wafVersion = '2.3.4'

    beforeEach(() => {
      DDWAF.prototype.constructor.version.returns(wafVersion)

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

      waf.update(rules)

      expect(DDWAF.prototype.update).to.be.calledOnceWithExactly(rules)
    })

    it('should call Reporter.reportWafUpdate', () => {
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

      waf.update(rules)

      expect(Reporter.reportWafUpdate).to.be.calledOnceWithExactly(wafVersion,
        DDWAF.prototype.diagnostics.ruleset_version)
    })
  })

  describe('WAFContextWrapper', () => {
    let ddwafContext, wafContextWrapper, req

    beforeEach(() => {
      req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          'host': 'localhost',
          cookie: 'a=1;b=2'
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080
        }
      }

      waf.init(rules, config.appsec)

      ddwafContext = {
        dispose: sinon.stub(),
        run: sinon.stub(),
        disposed: false
      }

      DDWAF.prototype.createContext.returns(ddwafContext)

      wafContextWrapper = waf.wafManager.getWAFContext(req)
    })

    describe('dispose', () => {
      it('should call ddwafContext.dispose', () => {
        waf.disposeContext(req)
        expect(ddwafContext.dispose).to.be.calledOnce
      })
    })

    describe('run', () => {
      it('should not call ddwafContext.run without params', () => {
        waf.run()
        expect(ddwafContext.run).not.to.be.called
      })

      it('should not call ddwafContext.run with invalid params', () => {
        waf.run({
          'invalid_address': 'value'
        }, req)
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

      it('should report attack when ddwafContext returns events', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1,
          events: ['ATTACK DATA']
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).to.be.calledOnceWithExactly('["ATTACK DATA"]')
      })

      it('should report if rule is triggered', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1,
          events: ['ruleTriggered']
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportMetrics).to.be.calledOnce

        const reportMetricsArg = Reporter.reportMetrics.firstCall.args[0]
        expect(reportMetricsArg.ruleTriggered).to.be.true
      })

      it('should not report attack when ddwafContext does not return events', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should not report attack when ddwafContext returns empty data', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, events: [] })
        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should return the actions', () => {
        const actions = ['block']
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, events: [], actions: actions })

        const params = {
          'server.request.headers.no_cookies': { 'header': 'value' }
        }

        const result = wafContextWrapper.run(params)

        expect(result).to.be.equals(actions)
      })
    })
  })
})
