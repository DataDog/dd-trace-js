'use strict'

const assert = require('node:assert/strict')

const { performance } = require('node:perf_hooks')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

describe('API Security Sampler', () => {
  const req = { route: { path: '/test' }, method: 'GET' }
  const res = { statusCode: 200 }
  let apiSecuritySampler, webStub, span, clock, performanceNowStub

  beforeEach(() => {
    clock = sinon.useFakeTimers({
      now: 10,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    performanceNowStub = sinon.stub(performance, 'now').callsFake(() => clock.now)

    webStub = {
      root: sinon.stub(),
      getContext: sinon.stub(),
      _prioritySampler: {
        isSampled: sinon.stub()
      }
    }

    apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
      '../plugins/util/web': webStub
    })

    span = {
      context: sinon.stub().returns({
        _sampling: { priority: AUTO_KEEP }
      })
    }

    webStub.root.returns(span)
    webStub.getContext.returns({ paths: ['path'] })
  })

  afterEach(() => {
    apiSecuritySampler.disable()
    performanceNowStub.restore()
    clock.restore()
  })

  it('should return false if not enabled', () => {
    apiSecuritySampler.disable()
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, {}), false)
  })

  it('should return false if no root span', () => {
    webStub.root.returns(null)
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, {}), false)
  })

  it('should return false for AUTO_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: AUTO_REJECT } })
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), false)
  })

  it('should return false for USER_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: USER_REJECT } })
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), false)
  })

  it('should not sample when method or statusCode is not available', () => {
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, {}, true), false)
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, res, true), false)
  })

  describe('with TTLCache', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, sampleDelay: 30 } } })
    })

    it('should not sample before 30 seconds', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      clock.tick(25000)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), false)
      const key = apiSecuritySampler.computeKey(req, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key), true)
    })

    it('should sample after 30 seconds', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      clock.tick(35000)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
    })

    it('should remove oldest entry when max size is exceeded', () => {
      for (let i = 0; i < 4097; i++) {
        const path = `/test${i}`
        webStub.getContext.returns({ paths: [path] })
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
      }

      webStub.getContext.returns({ paths: ['/test0'] })
      const key1 = apiSecuritySampler.computeKey(req, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key1), false)

      webStub.getContext.returns({ paths: ['/test4096'] })
      const key2 = apiSecuritySampler.computeKey(req, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key2), true)
    })

    it('should set enabled to false and clear the cache', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      apiSecuritySampler.disable()

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), false)
    })

    it('should create different keys for different methods', () => {
      const getReq = { method: 'GET' }
      const postReq = { method: 'POST' }
      assert.strictEqual(apiSecuritySampler.sampleRequest(getReq, res, true), true)
      assert.strictEqual(apiSecuritySampler.sampleRequest(postReq, res, true), true)

      const key1 = apiSecuritySampler.computeKey(getReq, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key1), true)
      const key2 = apiSecuritySampler.computeKey(postReq, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key2), true)
    })

    it('should create different keys for different status codes', () => {
      const res200 = { statusCode: 200 }
      const res404 = { statusCode: 404 }

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res200, true), true)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res404, true), true)

      const key1 = apiSecuritySampler.computeKey(req, res200)
      assert.strictEqual(apiSecuritySampler.isSampled(key1), true)
      const key2 = apiSecuritySampler.computeKey(req, res404)
      assert.strictEqual(apiSecuritySampler.isSampled(key2), true)
    })

    it('should sample for AUTO_KEEP priority without checking prioritySampler', () => {
      span.context.returns({ _sampling: { priority: AUTO_KEEP } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), true)
    })

    it('should sample for USER_KEEP priority without checking prioritySampler', () => {
      span.context.returns({ _sampling: { priority: USER_KEEP } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), true)
    })
  })

  describe('with NoopTTLCache', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, sampleDelay: 0 } } })
    })

    it('should always return true for sampleRequest', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      clock.tick(50000)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
    })

    it('should never mark requests as sampled', () => {
      apiSecuritySampler.sampleRequest(req, res, true)
      const key = apiSecuritySampler.computeKey(req, res)
      assert.strictEqual(apiSecuritySampler.isSampled(key), false)
    })

    it('should handle multiple different requests', () => {
      const requests = [
        { req: { method: 'GET', route: { path: '/test1' } }, res: { statusCode: 200 } },
        { req: { method: 'POST', route: { path: '/test2' } }, res: { statusCode: 201 } },
        { req: { method: 'PUT', route: { path: '/test3' } }, res: { statusCode: 204 } }
      ]

      requests.forEach(({ req, res }) => {
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
        const key = apiSecuritySampler.computeKey(req, res)
        assert.strictEqual(apiSecuritySampler.isSampled(key), false)
      })
    })

    it('should not be affected by max size', () => {
      for (let i = 0; i < 5000; i++) {
        webStub.getContext.returns({ paths: [`/test${i}`] })
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
      }

      webStub.getContext.returns({ paths: ['/test0'] })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)

      webStub.getContext.returns({ paths: ['/test4999'] })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
    })
  })

  describe('ASM Standalone', () => {
    let keepTraceStub

    beforeEach(() => {
      keepTraceStub = sinon.stub()
      apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
        '../plugins/util/web': webStub,
        '../priority_sampler': {
          keepTrace: keepTraceStub
        },
        '../standalone/product': {
          ASM: 'asm'
        }
      })
      apiSecuritySampler.configure({
        appsec: {
          apiSecurity: {
            enabled: true,
            sampleDelay: 30
          }
        },
        apmTracingEnabled: false
      })
    })

    it('should keep trace with ASM product when in standalone mode', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), false)
      assert.strictEqual(keepTraceStub.calledOnceWith(span, 'asm'), true)
    })

    it('should not check priority sampling in standalone mode', () => {
      span.context.returns({ _sampling: { priority: AUTO_REJECT } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), true)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), false)
      assert.strictEqual(keepTraceStub.calledOnceWith(span, 'asm'), true)
    })
  })
})
