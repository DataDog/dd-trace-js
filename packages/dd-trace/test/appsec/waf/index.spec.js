'use strict'

const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const rules = require('../../../src/appsec/recommended.json')
const Reporter = require('../../../src/appsec/reporter')
const web = require('../../../src/plugins/util/web')

describe('WAF Manager', () => {
  const knownAddresses = new Set([
    'server.io.net.url',
    'server.request.headers.no_cookies',
    'server.request.uri.raw',
    'processor.address',
    'server.request.body',
    'waf.context.processor'
  ])
  let waf, WAFManager
  let DDWAF
  let config
  let webContext

  beforeEach(() => {
    config = new Config()

    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub().returns('1.2.3')
    DDWAF.prototype.dispose = sinon.stub()
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.diagnostics = {
      ruleset_version: '1.0.0',
      rules: {
        loaded: ['rule_1'], failed: []
      }
    }
    DDWAF.prototype.knownAddresses = knownAddresses

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
    sinon.stub(Reporter, 'reportDerivatives')
    sinon.spy(Reporter, 'reportWafInit')

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
      expect(Reporter.reportWafInit).to.have.been.calledWithExactly(
        '1.2.3',
        '1.0.0',
        true
      )
    })

    it('should handle failed DDWAF loading', () => {
      const error = new Error('Failed to initialize DDWAF')
      DDWAF.version.returns('1.2.3')
      DDWAF.throws(error)

      try {
        waf.init(rules, config.appsec)
        expect.fail('waf init should have thrown an error')
      } catch (err) {
        expect(err).to.equal(error)
        expect(Reporter.reportWafInit).to.have.been.calledWith('1.2.3', 'unknown')
      }
    })

    it('should set init metrics without error', () => {
      waf.init(rules, config.appsec)

      expect(Reporter.metricsQueue.set).to.have.been.calledWithExactly('_dd.appsec.waf.version', '1.2.3')
    })
  })

  describe('run', () => {
    it('should call wafManager.run with raspRuleType', () => {
      const run = sinon.stub()
      WAFManager.prototype.getWAFContext = sinon.stub().returns({ run })
      waf.init(rules, config.appsec)

      const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
      const req = {}
      waf.run(payload, req, 'ssrf')

      expect(run).to.be.calledOnceWithExactly(payload, 'ssrf')
    })

    it('should call wafManager.run without raspRuleType', () => {
      const run = sinon.stub()
      WAFManager.prototype.getWAFContext = sinon.stub().returns({ run })
      waf.init(rules, config.appsec)

      const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
      const req = {}
      waf.run(payload, req)

      expect(run).to.be.calledOnceWithExactly(payload, undefined)
    })
  })

  describe('wafManager.createDDWAFContext', () => {
    beforeEach(() => {
      DDWAF.version.returns('4.5.6')
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

  describe('WAFContextWrapper', () => {
    let ddwafContext, wafContextWrapper, req

    beforeEach(() => {
      req = {
        url: '/path',
        headers: {
          'user-agent': 'Arachni',
          host: 'localhost',
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

      it('should call ddwafContext.run with params', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })

        wafContextWrapper.run({
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' },
            'server.request.uri.raw': 'https://testurl',
            'processor.address': { 'extract-schema': true }
          }
        })

        expect(ddwafContext.run).to.be.calledOnceWithExactly({
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' },
            'server.request.uri.raw': 'https://testurl',
            'processor.address': { 'extract-schema': true }
          }
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
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).to.be.calledOnceWithExactly(['ATTACK DATA'])
      })

      it('should report if rule is triggered', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1,
          events: ['ruleTriggered']
        }

        ddwafContext.run.returns(result)
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportMetrics).to.be.calledOnce

        const reportMetricsArg = Reporter.reportMetrics.firstCall.args[0]
        expect(reportMetricsArg.ruleTriggered).to.be.true
      })

      it('should report raspRuleType', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1
        }

        ddwafContext.run.returns(result)
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params, 'rule_type')

        expect(Reporter.reportMetrics).to.be.calledOnce
        expect(Reporter.reportMetrics.firstCall.args[1]).to.be.equal('rule_type')
      })

      it('should not report raspRuleType when it is not provided', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1
        }

        ddwafContext.run.returns(result)
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportMetrics).to.be.calledOnce
        expect(Reporter.reportMetrics.firstCall.args[1]).to.be.equal(undefined)
      })

      it('should not report attack when ddwafContext does not return events', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1 })
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should not report attack when ddwafContext returns empty data', () => {
        ddwafContext.run.returns({ totalRuntime: 1, durationExt: 1, events: [] })
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should return waf result', () => {
        const result = {
          totalRuntime: 1, durationExt: 1, events: [], actions: ['block']
        }
        ddwafContext.run.returns(result)

        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        const wafResult = wafContextWrapper.run(params)

        expect(wafResult).to.be.equals(result)
      })

      it('should report schemas when ddwafContext returns schemas in the derivatives', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1,
          derivatives: [{ '_dd.appsec.s.req.body': [8] }]
        }
        const params = {
          persistent: {
            'server.request.body': 'value',
            'waf.context.processor': {
              'extract-schema': true
            }
          }
        }

        ddwafContext.run.returns(result)

        wafContextWrapper.run(params)
        expect(Reporter.reportDerivatives).to.be.calledOnceWithExactly(result.derivatives)
      })

      it('should report fingerprints when ddwafContext returns fingerprints in results derivatives', () => {
        const result = {
          totalRuntime: 1,
          durationExt: 1,
          derivatives: {
            '_dd.appsec.s.req.body': [8],
            '_dd.appsec.fp.http.endpoint': 'http-post-abcdefgh-12345678-abcdefgh',
            '_dd.appsec.fp.http.network': 'net-1-0100000000',
            '_dd.appsec.fp.http.headers': 'hdr-0110000110-abcdefgh-5-12345678'
          }
        }

        ddwafContext.run.returns(result)

        wafContextWrapper.run({
          persistent: {
            'server.request.body': 'foo'
          }
        })
        sinon.assert.calledOnceWithExactly(Reporter.reportDerivatives, result.derivatives)
      })
    })
  })
})
