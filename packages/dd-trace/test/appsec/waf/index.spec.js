'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { match } = require('sinon')

const rules = require('../../../src/appsec/recommended.json')
const Reporter = require('../../../src/appsec/reporter')
const { ASM } = require('../../../src/standalone/product')
const { getConfigFresh } = require('../../helpers/config')

describe('WAF Manager', () => {
  const knownAddresses = new Set([
    'server.io.net.url',
    'server.request.headers.no_cookies',
    'server.request.uri.raw',
    'processor.address',
    'server.request.body',
    'waf.context.processor',
  ])
  let waf, WAFManager, keepTrace, updateRateLimitedMetric, root, getActiveRequest
  let DDWAF
  const config = getConfigFresh()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub().returns('1.2.3')
    DDWAF.prototype.dispose = sinon.stub()
    DDWAF.prototype.createContext = sinon.stub().returns({
      run: sinon.stub(),
      dispose: sinon.stub().callsFake(function () { this.disposed = true }),
      disposed: false,
    })
    DDWAF.prototype.diagnostics = {
      ruleset_version: '1.0.0',
      rules: {
        loaded: ['rule_1'], failed: [],
      },
    }
    DDWAF.prototype.createOrUpdateConfig = sinon.stub().returns(true)
    DDWAF.prototype.removeConfig = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses

    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      '@datadog/native-appsec': { DDWAF },
    })

    getActiveRequest = sinon.stub().returns({})
    keepTrace = sinon.spy()
    updateRateLimitedMetric = sinon.spy()
    root = sinon.stub().returns({})
    waf = proxyquire('../../../src/appsec/waf', {
      '../../priority_sampler': { keepTrace },
      '../../plugins/util/web': { root },
      '../telemetry': { updateRateLimitedMetric },
      './waf_manager': WAFManager,
      '../store': { getActiveRequest },
    })
    waf.destroy()

    sinon.stub(Reporter.metricsQueue, 'set')
    sinon.stub(Reporter, 'reportMetrics')
    sinon.stub(Reporter, 'reportAttack')
    sinon.stub(Reporter, 'reportAttributes')
    sinon.spy(Reporter, 'reportWafInit')
    sinon.spy(Reporter, 'reportWafConfigUpdate')
  })

  afterEach(() => {
    sinon.restore()
    waf.destroy()
  })

  describe('init', () => {
    it('should initialize the manager', () => {
      assert.strictEqual(waf.wafManager, null)
      waf.init(rules, config.appsec)

      assert.notStrictEqual(waf.wafManager, null)
      assert.ok(waf.wafManager.ddwaf instanceof DDWAF)
      sinon.assert.calledWithExactly(Reporter.reportWafInit,
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
        assert.fail('waf init should have thrown an error')
      } catch (err) {
        assert.strictEqual(err, error)
        sinon.assert.calledWith(Reporter.reportWafInit, '1.2.3', 'unknown')
      }
    })

    it('should set init metrics without error', () => {
      waf.init(rules, config.appsec)

      sinon.assert.calledWithExactly(Reporter.metricsQueue.set, '_dd.appsec.waf.version', '1.2.3')
    })
  })

  describe('run', () => {
    it('skips evaluation and disposal when there is no active ruleset', () => {
      DDWAF.prototype.createContext.returns(null)
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      assert.strictEqual(waf.run({ 'server.request.body': 'ordinary' }, req), undefined)
      waf.disposeContext(req)
      sinon.assert.calledTwice(DDWAF.prototype.createContext)
      sinon.assert.notCalled(Reporter.reportMetrics)
    })

    it('should call wafManager.run with raspRuleType', () => {
      const run = sinon.stub()
      WAFManager.prototype.getWAFContext = sinon.stub().returns({ run })
      waf.init(rules, config.appsec)

      const payload = { 'server.io.net.url': 'http://example.com' }
      const req = {}
      getActiveRequest.returns(req)
      waf.run(payload, req, 'ssrf')

      sinon.assert.calledOnceWithExactly(run, payload, 'ssrf', undefined)
    })

    it('should call wafManager.run without raspRuleType', () => {
      const run = sinon.stub()
      WAFManager.prototype.getWAFContext = sinon.stub().returns({ run })
      waf.init(rules, config.appsec)

      const payload = { 'server.io.net.url': 'http://example.com' }
      const req = {}
      getActiveRequest.returns(req)
      waf.run(payload, req)

      sinon.assert.calledOnceWithExactly(run, payload, undefined, undefined)
    })
  })

  describe('trace retention', () => {
    beforeEach(() => {
      sinon.useFakeTimers()
      waf.init(rules, { ...config.appsec, DD_APPSEC_TRACE_RATE_LIMIT: 1 })
    })

    it('shares the limit between request and subcontext evaluations', () => {
      const req = {}
      getActiveRequest.returns(req)
      const data = { 'server.request.body': 'body' }
      const context = waf.wafManager.getWAFContext(req)
      context.ddwafContext.run.returns({ duration: 1000, keep: true })
      context.ddwafContext.createSubcontext = sinon.stub().returns({
        run: sinon.stub().returns({ duration: 1000, keep: true }),
        dispose: sinon.spy(),
      })
      const state = {}
      waf.runSubContext(data, { type: 'ssrf' }, state)
      waf.run(data, req)

      sinon.assert.calledOnceWithExactly(keepTrace, root.firstCall.returnValue, ASM)
      sinon.assert.calledOnceWithExactly(updateRateLimitedMetric, req)
      waf.disposeContext(req)
    })

    it('only consumes capacity for keep decisions and resets the limit on init', () => {
      const req = {}
      getActiveRequest.returns(req)
      const data = { 'server.request.body': 'body' }
      const native = waf.wafManager.getWAFContext(req).ddwafContext
      native.run.returns({ duration: 1000 })
      waf.run(data, req)
      native.run.returns({ duration: 1000, keep: true })
      waf.run(data, req)
      waf.run(data, req)
      waf.init(rules, { ...config.appsec, DD_APPSEC_TRACE_RATE_LIMIT: 1 })
      waf.run(data, req)

      sinon.assert.calledTwice(keepTrace)
      sinon.assert.calledOnceWithExactly(updateRateLimitedMetric, req)
      waf.disposeContext(req)
    })
  })

  describe('isolated evaluations', () => {
    const data = { 'server.request.body': 'ordinary' }

    for (const outcome of ['success', 'error', 'throw']) {
      it(`disposes the subcontext after a native ${outcome}`, () => {
        const child = {
          run: sinon.stub().returns({ duration: 1000, keep: true }),
          dispose: sinon.spy(),
        }
        if (outcome === 'error') child.run.returns({ errorCode: -2 })
        if (outcome === 'throw') child.run.throws(new Error('native failure'))
        const parent = DDWAF.prototype.createContext()
        parent.createSubcontext = sinon.stub().returns(child)
        waf.init(rules, config.appsec)
        const req = {}
        getActiveRequest.returns(req)

        waf.runSubContext(data, { type: 'sql_injection' })

        sinon.assert.calledOnceWithExactly(child.run, data, config.appsec.DD_APPSEC_WAF_TIMEOUT)
        sinon.assert.calledOnce(child.dispose)
        sinon.assert.notCalled(parent.run)
        waf.disposeContext(req)
        sinon.assert.calledOnce(child.dispose)
        if (outcome === 'success') {
          sinon.assert.calledOnce(keepTrace)
          sinon.assert.calledWithExactly(root, req)
        } else assert.strictEqual(Reporter.reportMetrics.firstCall.args[0].errorCode, outcome === 'error' ? -2 : -127)
      })
    }

    it('reuses a subcontext for paired evaluations and releases it after disable', () => {
      const child = {
        run: sinon.stub().returns({ duration: 1000 }),
        dispose: sinon.spy(function () { this.disposed = true }),
      }
      const parent = DDWAF.prototype.createContext()
      parent.createSubcontext = sinon.stub().returns(child)
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const state = {}

      waf.runSubContext(data, { type: 'ssrf', variant: 'request' }, state)
      assert.strictEqual(waf.getRequest(state), req)
      getActiveRequest.returns(undefined) // Later callbacks need not have the original active request.
      waf.runSubContext(data, { type: 'ssrf', variant: 'response' }, state)

      sinon.assert.calledOnce(parent.createSubcontext)
      sinon.assert.calledTwice(child.run)
      sinon.assert.notCalled(child.dispose)
      waf.destroy()
      waf.disposeSubContext(state)
      waf.disposeSubContext(state)
      sinon.assert.calledOnce(child.dispose)
      assert.strictEqual(waf.getRequest(state), undefined)
    })

    it('keeps simultaneous outgoing evaluations in separate subcontexts', () => {
      const first = { run: sinon.stub().returns({ duration: 1000 }), dispose: sinon.spy() }
      const second = { run: sinon.stub().returns({ duration: 1000 }), dispose: sinon.spy() }
      const parent = DDWAF.prototype.createContext()
      parent.createSubcontext = sinon.stub().onFirstCall().returns(first).onSecondCall().returns(second)
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const firstState = {}
      const secondState = {}

      waf.runSubContext(data, undefined, firstState)
      waf.runSubContext(data, undefined, secondState)
      waf.runSubContext(data, undefined, firstState)
      waf.disposeSubContext(firstState)

      sinon.assert.calledTwice(first.run)
      sinon.assert.calledOnce(second.run)
      sinon.assert.calledOnce(first.dispose)
      sinon.assert.notCalled(second.dispose)
      waf.disposeSubContext(secondState)
    })

    it('skips isolated checks when there is no active ruleset', () => {
      DDWAF.prototype.createContext.returns(null)
      waf.init(rules, config.appsec)
      assert.strictEqual(waf.runSubContext(data), undefined)
      sinon.assert.notCalled(Reporter.reportMetrics)
    })

    it('reports skipped RASP checks after the request context is disposed', () => {
      const parent = DDWAF.prototype.createContext()
      parent.disposed = true
      parent.createSubcontext = sinon.stub()
      const skipped = sinon.stub(Reporter, 'reportRaspRuleSkipped')
      waf.init(rules, config.appsec)
      const rule = { type: 'sql_injection' }

      assert.strictEqual(waf.runSubContext(data, rule), undefined)

      sinon.assert.calledOnceWithExactly(skipped, rule, 'after-request')
      sinon.assert.notCalled(parent.createSubcontext)
      sinon.assert.notCalled(parent.run)
    })

    it('does not create a context when looking up an unbound outgoing request', () => {
      waf.init(rules, config.appsec)
      assert.strictEqual(waf.getRequest({}), undefined)
      sinon.assert.notCalled(DDWAF.prototype.createContext)
    })

    it('skips new subcontexts without an active incoming request', () => {
      waf.init(rules, config.appsec)
      getActiveRequest.returns(undefined)
      assert.strictEqual(waf.runSubContext(data), undefined)
      sinon.assert.notCalled(DDWAF.prototype.createContext)
    })

    it('skips isolated checks while AppSec is disabled', () => {
      assert.strictEqual(waf.runSubContext(data), undefined)
      sinon.assert.notCalled(DDWAF.prototype.createContext)
    })
  })

  describe('request context ownership', () => {
    it('does not dispose or create contexts through the facade while disabled', () => {
      waf.disposeContext({})
      sinon.assert.notCalled(DDWAF.prototype.createContext)
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const context = waf.wafManager.getWAFContext(req)
      waf.destroy()
      waf.disposeContext(req)
      sinon.assert.notCalled(context.ddwafContext.dispose)
      context.dispose()
    })

    it('does not recreate a context for late checks after request disposal', () => {
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const context = waf.wafManager.getWAFContext(req)
      context.ddwafContext.dispose.callsFake(() => { context.ddwafContext.disposed = true })
      waf.disposeContext(req)

      waf.run({ 'server.request.body': 'late' }, req)
      waf.disposeContext(req)

      sinon.assert.calledOnce(DDWAF.prototype.createContext)
      sinon.assert.calledOnce(context.ddwafContext.dispose)
      sinon.assert.notCalled(context.ddwafContext.run)
    })

    it('preserves in-flight request contexts when the manager is replaced', () => {
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const context = waf.wafManager.getWAFContext(req)
      waf.init(rules, config.appsec)

      assert.strictEqual(waf.wafManager.getWAFContext(req), context)
      assert.strictEqual(context.ddwafContext.disposed, false)
      waf.disposeContext(req)

      sinon.assert.calledOnce(context.ddwafContext.dispose)
      sinon.assert.calledOnce(DDWAF.prototype.createContext)
    })

    it('reports against the explicit Lambda root span', () => {
      waf.init(rules, config.appsec)
      const req = {}
      getActiveRequest.returns(req)
      const span = {}
      const result = { duration: 1000, attributes: { 'appsec.tag': 'value' }, keep: true }
      DDWAF.prototype.createContext().run.returns(result)

      waf.run({ 'server.request.body': 'body' }, req, undefined, span)

      sinon.assert.calledOnceWithExactly(Reporter.reportAttributes, result.attributes, req, span)
      sinon.assert.calledOnceWithExactly(keepTrace, span, ASM)
      sinon.assert.notCalled(root)
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
          message: 'Cannot update disabled WAF',
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
          message: 'Cannot update disabled WAF',
        }
      )
    })
  })

  describe('configurations handling', () => {
    const ASM_CONFIG = {
      rules_override: [],
      actions: [],
      exclusions: [],
      custom_rules: [],
    }

    const ASM_DATA_CONFIG = {
      rules_data: [
        {
          data: [
            {
              expiration: 1661848350,
              value: '188.243.182.156',
            },
            {
              expiration: 1661848350,
              value: '51.222.158.205',
            },
          ],
          id: 'blocked_ips',
          type: 'ip_with_expiration',
        },
      ],
    }

    const ASM_DD_CONFIG = {
      version: '2.2',
      metadata: {
        rules_version: '1.42.11',
      },
      rules: [],
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
          name: 'WafUpdateError',
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
      getActiveRequest.returns(req)
      waf.wafManager.getWAFContext(req)
      sinon.assert.calledOnce(waf.wafManager.ddwaf.createContext)
    })

    it('should pass waf version when invoking ddwaf.createContext', () => {
      const req = {}
      getActiveRequest.returns(req)
      const context = waf.wafManager.getWAFContext(req)
      assert.strictEqual(context.wafVersion, '4.5.6')
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
          cookie: 'a=1;b=2',
        },
        method: 'POST',
        socket: {
          remoteAddress: '127.0.0.1',
          remotePort: 8080,
        },
      }

      waf.init(rules, config.appsec)

      ddwafContext = {
        dispose: sinon.stub(),
        run: sinon.stub(),
        disposed: false,
      }

      DDWAF.prototype.createContext.returns(ddwafContext)

      wafContextWrapper = waf.wafManager.getWAFContext(req)
    })

    describe('dispose', () => {
      it('should call ddwafContext.dispose', () => {
        waf.disposeContext(req)
        sinon.assert.calledOnce(ddwafContext.dispose)
      })
    })

    describe('run', () => {
      it('should not call ddwafContext.run without params', () => {
        waf.run()
        sinon.assert.notCalled(ddwafContext.run)
      })

      it('should call ddwafContext.run with params', () => {
        ddwafContext.run.returns({ duration: 1, durationExt: 1 })

        wafContextWrapper.run({
          'server.request.headers.no_cookies': { header: 'value' },
          'server.request.uri.raw': 'https://testurl',
          'processor.address': { 'extract-schema': true },
        })

        sinon.assert.calledOnceWithExactly(ddwafContext.run, {
          'server.request.headers.no_cookies': { header: 'value' },
          'server.request.uri.raw': 'https://testurl',
          'processor.address': { 'extract-schema': true },
        }, config.appsec.DD_APPSEC_WAF_TIMEOUT)
      })

      it('should report attack when ddwafContext returns events', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          events: ['ATTACK DATA'],
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params)

        sinon.assert.calledOnceWithExactly(Reporter.reportAttack, match({ events: ['ATTACK DATA'] }), req, undefined)
      })

      it('should report if rule is triggered', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          events: ['ruleTriggered'],
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params)

        sinon.assert.calledOnce(Reporter.reportMetrics)

        const reportMetricsArg = Reporter.reportMetrics.firstCall.args[0]
        assert.strictEqual(reportMetricsArg.ruleTriggered, true)
      })

      it('should report raspRuleType', () => {
        const result = {
          duration: 1,
          durationExt: 1,
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params, 'rule_type')

        sinon.assert.calledOnce(Reporter.reportMetrics)
        assert.strictEqual(Reporter.reportMetrics.firstCall.args[1], 'rule_type')
      })

      it('should not report raspRuleType when it is not provided', () => {
        const result = {
          duration: 1,
          durationExt: 1,
        }

        ddwafContext.run.returns(result)
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params)

        sinon.assert.calledOnce(Reporter.reportMetrics)
        assert.strictEqual(Reporter.reportMetrics.firstCall.args[1], undefined)
      })

      it('should not report attack when ddwafContext does not return events', () => {
        ddwafContext.run.returns({ duration: 1, durationExt: 1 })
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params)

        sinon.assert.notCalled(Reporter.reportAttack)
      })

      it('should not report attack when ddwafContext returns empty data', () => {
        ddwafContext.run.returns({ duration: 1, durationExt: 1, events: [] })
        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        wafContextWrapper.run(params)

        sinon.assert.notCalled(Reporter.reportAttack)
      })

      it('should return waf result', () => {
        const result = {
          duration: 1, durationExt: 1, events: [], actions: ['block'],
        }
        ddwafContext.run.returns(result)

        const params = {
          'server.request.headers.no_cookies': { header: 'value' },
        }

        const wafResult = wafContextWrapper.run(params)

        assert.strictEqual(wafResult, result)
      })

      it('should report schemas when ddwafContext returns schemas in the attributes', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          attributes: [{ '_dd.appsec.s.req.body': [8] }],
        }
        const params = {
          'server.request.body': 'value',
          'waf.context.processor': {
            'extract-schema': true,
          },
        }

        ddwafContext.run.returns(result)

        wafContextWrapper.run(params)
        sinon.assert.calledOnceWithExactly(Reporter.reportAttributes, result.attributes, req, undefined)
      })

      it('should report fingerprints when ddwafContext returns fingerprints in results attributes', () => {
        const result = {
          duration: 1,
          durationExt: 1,
          attributes: {
            '_dd.appsec.s.req.body': [8],
            '_dd.appsec.fp.http.endpoint': 'http-post-abcdefgh-12345678-abcdefgh',
            '_dd.appsec.fp.http.network': 'net-1-0100000000',
            '_dd.appsec.fp.http.headers': 'hdr-0110000110-abcdefgh-5-12345678',
          },
        }

        ddwafContext.run.returns(result)

        wafContextWrapper.run({
          'server.request.body': 'foo',
        })
        sinon.assert.calledOnceWithExactly(Reporter.reportAttributes, result.attributes, req, undefined)
      })
    })
  })
})
