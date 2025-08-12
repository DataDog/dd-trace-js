'use strict'

const assert = require('node:assert')
const proxyquire = require('proxyquire')
const Config = require('../../../src/config')
const rules = require('../../../src/appsec/recommended.json')
const Reporter = require('../../../src/appsec/reporter')

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
  let keepTrace, updateRateLimitedMetric, limiterStub

  beforeEach(() => {
    config = new Config()

    limiterStub = {
      isAllowed: sinon.stub().returns(true)
    }

    keepTrace = sinon.stub()
    updateRateLimitedMetric = sinon.stub()

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
    DDWAF.prototype.createOrUpdateConfig = sinon.stub().returns(true)
    DDWAF.prototype.removeConfig = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses

    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      '@datadog/native-appsec': { DDWAF }
    })

    const webMock = {
      root: sinon.stub().returns({ mock: 'rootSpan' }),
      getContext: sinon.stub().returns(webContext)
    }

    waf = proxyquire('../../../src/appsec/waf', {
      './waf_manager': WAFManager,
      '../../rate_limiter': function () { return limiterStub },
      '../../priority_sampler': { keepTrace },
      '../../standalone/product': { ASM: 'ASM' },
      '../../../../datadog-plugin-web/src/utils': webMock,
      '../telemetry': { updateRateLimitedMetric }
    })
    waf.destroy()

    sinon.stub(Reporter.metricsQueue, 'set')
    sinon.stub(Reporter, 'reportMetrics')
    sinon.stub(Reporter, 'reportAttack')
    sinon.stub(Reporter, 'reportAttributes')
    sinon.spy(Reporter, 'reportWafInit')
    sinon.spy(Reporter, 'reportWafConfigUpdate')

    webContext = {}
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
        { loaded: ['rule_1'], failed: [] },
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

    describe('sampling priority', () => {
      let mockWafContext, req

      beforeEach(() => {
        req = { mock: 'request' }
        mockWafContext = { run: sinon.stub() }
        WAFManager.prototype.getWAFContext = sinon.stub().returns(mockWafContext)
        waf.init(rules, config.appsec)
      })

      it('should call keepTrace when result.keep is true and rate limiter allows', () => {
        const result = { keep: true, events: [] }
        mockWafContext.run.returns(result)
        limiterStub.isAllowed.returns(true)

        const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
        waf.run(payload, req)

        expect(keepTrace).to.have.been.calledOnceWithExactly({ mock: 'rootSpan' }, 'ASM')
        expect(updateRateLimitedMetric).not.to.have.been.called
      })

      it('should call updateRateLimitedMetric when result.keep is true but rate limiter denies', () => {
        const result = { keep: true, events: [] }
        mockWafContext.run.returns(result)
        limiterStub.isAllowed.returns(false)

        const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
        waf.run(payload, req)

        expect(updateRateLimitedMetric).to.have.been.calledOnceWithExactly(req)
        expect(keepTrace).not.to.have.been.called
      })

      it('should not call keepTrace or updateRateLimitedMetric when result.keep is false', () => {
        const result = { keep: false, events: [] }
        mockWafContext.run.returns(result)
        limiterStub.isAllowed.returns(true)

        const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
        waf.run(payload, req)

        expect(keepTrace).not.to.have.been.called
        expect(updateRateLimitedMetric).not.to.have.been.called
      })

      it('should not call keepTrace or updateRateLimitedMetric when result.keep is undefined', () => {
        const result = { events: [] }
        mockWafContext.run.returns(result)
        limiterStub.isAllowed.returns(true)

        const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
        waf.run(payload, req)

        expect(keepTrace).not.to.have.been.called
        expect(updateRateLimitedMetric).not.to.have.been.called
      })

      it('should not call keepTrace or updateRateLimitedMetric when result is null', () => {
        mockWafContext.run.returns(null)
        limiterStub.isAllowed.returns(true)

        const payload = { persistent: { 'server.io.net.url': 'http://example.com' } }
        waf.run(payload, req)

        expect(keepTrace).not.to.have.been.called
        expect(updateRateLimitedMetric).not.to.have.been.called
      })
    })
  })

  describe('waf disabled check', () => {
    it('should fail when updating configs on disabled waf', () => {
      assert.throws(
        () => {
          waf.updateConfig('path', {})
        },
        {
          name: 'Error',
          message: 'Cannot update disabled WAF'
        }
      )
    })

    it('should fail when removing configs on disabled waf', () => {
      assert.throws(
        () => {
          waf.removeConfig('path', {})
        },
        {
          name: 'Error',
          message: 'Cannot update disabled WAF'
        }
      )
    })
  })

  describe('configurations handling', () => {
    const ASM_CONFIG = {
      rules_override: [],
      actions: [],
      exclusions: [],
      custom_rules: []
    }

    const ASM_DATA_CONFIG = {
      rules_data: [
        {
          data: [
            {
              expiration: 1661848350,
              value: '188.243.182.156'
            },
            {
              expiration: 1661848350,
              value: '51.222.158.205'
            }
          ],
          id: 'blocked_ips',
          type: 'ip_with_expiration'
        }
      ]
    }

    const ASM_DD_CONFIG = {
      version: '2.2',
      metadata: {
        rules_version: '1.42.11'
      },
      rules: []
    }

    beforeEach(() => {
      waf.init(rules, config.appsec)
    })

    afterEach(() => {
      sinon.restore()
    })

    describe('update config', () => {
      it('should update WAF config - ASM / ASM_DATA', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        waf.updateConfig('ASM', 'config_id_1', 'datadog/00/ASM/test/update_config', ASM_CONFIG)
        waf.updateConfig('ASM_DATA', 'config_id_2', 'datadog/00/ASM_DATA/test/update_config', ASM_DATA_CONFIG)

        sinon.assert.calledWithExactly(
          DDWAF.prototype.createOrUpdateConfig.getCall(0),
          ASM_CONFIG,
          'datadog/00/ASM/test/update_config'
        )
        sinon.assert.calledWithExactly(
          DDWAF.prototype.createOrUpdateConfig.getCall(1),
          ASM_DATA_CONFIG,
          'datadog/00/ASM_DATA/test/update_config'
        )
      })

      it('should remove default rules on ASM_DD update', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        waf.updateConfig('ASM_DD', 'config_id_1', 'datadog/00/ASM_DD/test/update_config', ASM_DD_CONFIG)

        sinon.assert.calledOnceWithExactly(
          DDWAF.prototype.removeConfig,
          'datadog/00/ASM_DD/default/config'
        )
        sinon.assert.calledOnceWithExactly(
          DDWAF.prototype.createOrUpdateConfig,
          ASM_DD_CONFIG,
          'datadog/00/ASM_DD/test/update_config'
        )
      })
    })

    describe('remove config', () => {
      it('should remove WAF config', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        waf.removeConfig('path/to/remove')

        sinon.assert.calledOnceWithExactly(DDWAF.prototype.removeConfig, 'path/to/remove')
      })
    })

    it('should throw WafUpdateError on failed update', () => {
      DDWAF.prototype.configPaths = []
      DDWAF.prototype.createOrUpdateConfig.returns(false)

      assert.throws(
        () => {
          waf.updateConfig('path', {})
        },
        {
          name: 'WafUpdateError'
        }
      )
    })

    it('should report waf config update', () => {
      DDWAF.prototype.configPaths = []
      DDWAF.prototype.createOrUpdateConfig.returns(true)

      waf.updateConfig('ASM', 'configId', 'path', {})

      sinon.assert.calledOnceWithExactly(
        Reporter.reportWafConfigUpdate,
        'ASM',
        'configId',
        DDWAF.prototype.diagnostics,
        '1.2.3'
      )
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
        ddwafContext.run.returns({ duration: 1, durationExt: 1 })

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
          duration: 1,
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
          duration: 1,
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
          duration: 1,
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
          duration: 1,
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
        ddwafContext.run.returns({ duration: 1, durationExt: 1 })
        const params = {
          persistent: {
            'server.request.headers.no_cookies': { header: 'value' }
          }
        }

        wafContextWrapper.run(params)

        expect(Reporter.reportAttack).not.to.be.called
      })

      it('should not report attack when ddwafContext returns empty data', () => {
        ddwafContext.run.returns({ duration: 1, durationExt: 1, events: [] })
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
          duration: 1, durationExt: 1, events: [], actions: ['block']
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

      it('should report schemas when ddwafContext returns schemas in the attributes', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          attributes: [{ '_dd.appsec.s.req.body': [8] }]
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
        expect(Reporter.reportAttributes).to.be.calledOnceWithExactly(result.attributes)
      })

      it('should report fingerprints when ddwafContext returns fingerprints in results attributes', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          attributes: {
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
        sinon.assert.calledOnceWithExactly(Reporter.reportAttributes, result.attributes)
      })
    })
  })
})
