'use strict'

const assert = require('node:assert/strict')

const { performance } = require('node:perf_hooks')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT, USER_REJECT } = require('../../../../../ext/priority')

describe('API Security Sampler', () => {
  const req = { route: { path: '/test' }, method: 'GET' }
  const res = { statusCode: 200 }
  let apiSecuritySampler, SamplingDecision, webStub, blockingStub, span, clock, performanceNowStub

  beforeEach(() => {
    clock = sinon.useFakeTimers({
      now: 10,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    performanceNowStub = sinon.stub(performance, 'now').callsFake(() => clock.now)

    webStub = {
      root: sinon.stub(),
      getContext: sinon.stub(),
      _prioritySampler: {
        isSampled: sinon.stub(),
      },
    }

    blockingStub = {
      isBlocked: sinon.stub().returns(false),
    }

    apiSecuritySampler = proxyquire('../../../src/appsec/api_security/sampler', {
      '../../plugins/util/web': webStub,
      '../blocking': blockingStub,
    })
    SamplingDecision = apiSecuritySampler.SamplingDecision

    span = {
      context: sinon.stub().returns({
        _sampling: { priority: AUTO_KEEP },
      }),
    }

    webStub.root.returns(span)
    webStub.getContext.returns({ paths: ['path'] })
  })

  afterEach(() => {
    apiSecuritySampler.disable()
    performanceNowStub.restore()
    clock.restore()
  })

  it('should return SKIP if not enabled', () => {
    apiSecuritySampler.disable()
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, {}), SamplingDecision.SKIP)
  })

  it('should return SKIP if no root span', () => {
    webStub.root.returns(null)
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, {}), SamplingDecision.SKIP)
  })

  it('should return SKIP for AUTO_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: AUTO_REJECT } })
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), SamplingDecision.SKIP)
  })

  it('should return SKIP for USER_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: USER_REJECT } })
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), SamplingDecision.SKIP)
  })

  it('should return SKIP when method or statusCode is not available', () => {
    assert.strictEqual(apiSecuritySampler.sampleRequest(req, {}, true), SamplingDecision.SKIP)
    assert.strictEqual(apiSecuritySampler.sampleRequest({}, res, true), SamplingDecision.SKIP)
  })

  describe('with TTLCache', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, DD_API_SECURITY_SAMPLE_DELAY: 30 } } })
    })

    it('should not sample before 30 seconds', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      clock.tick(25000)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), true)
    })

    it('should sample after 30 seconds', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      clock.tick(35000)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
    })

    it('should remove oldest entry when max size is exceeded', () => {
      for (let i = 0; i < 4097; i++) {
        const path = `/test${i}`
        webStub.getContext.returns({ paths: [path] })
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
      }

      webStub.getContext.returns({ paths: ['/test0'] })
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), false)

      webStub.getContext.returns({ paths: ['/test4096'] })
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), true)
    })

    it('should set enabled to false and clear the cache', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      apiSecuritySampler.disable()

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
    })

    it('should create different keys for different methods', () => {
      const getReq = { method: 'GET' }
      const postReq = { method: 'POST' }
      assert.strictEqual(apiSecuritySampler.sampleRequest(getReq, res, true), SamplingDecision.SAMPLE)
      assert.strictEqual(apiSecuritySampler.sampleRequest(postReq, res, true), SamplingDecision.SAMPLE)

      assert.strictEqual(apiSecuritySampler.wasSampled(getReq, res), true)
      assert.strictEqual(apiSecuritySampler.wasSampled(postReq, res), true)
    })

    it('should create different keys for different status codes', () => {
      const res200 = { statusCode: 200 }
      const res404 = { statusCode: 404 }

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res200, true), SamplingDecision.SAMPLE)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res404, true), SamplingDecision.SAMPLE)

      assert.strictEqual(apiSecuritySampler.wasSampled(req, res200), true)
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res404), true)
    })

    it('should sample for AUTO_KEEP priority without checking prioritySampler', () => {
      span.context.returns({ _sampling: { priority: AUTO_KEEP } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), SamplingDecision.SAMPLE)
    })

    it('should sample for USER_KEEP priority without checking prioritySampler', () => {
      span.context.returns({ _sampling: { priority: USER_KEEP } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res), SamplingDecision.SAMPLE)
    })
  })

  describe('with NoopTTLCache', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, DD_API_SECURITY_SAMPLE_DELAY: 0 } } })
    })

    it('should always return SAMPLE for sampleRequest', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      clock.tick(50000)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
    })

    it('should never mark requests as sampled', () => {
      apiSecuritySampler.sampleRequest(req, res, true)
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), false)
    })

    it('should handle multiple different requests', () => {
      const requests = [
        { req: { method: 'GET', route: { path: '/test1' } }, res: { statusCode: 200 } },
        { req: { method: 'POST', route: { path: '/test2' } }, res: { statusCode: 201 } },
        { req: { method: 'PUT', route: { path: '/test3' } }, res: { statusCode: 204 } },
      ]

      requests.forEach(({ req, res }) => {
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
        assert.strictEqual(apiSecuritySampler.wasSampled(req, res), false)
      })
    })

    it('should not be affected by max size', () => {
      for (let i = 0; i < 5000; i++) {
        webStub.getContext.returns({ paths: [`/test${i}`] })
        assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
      }

      webStub.getContext.returns({ paths: ['/test0'] })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      webStub.getContext.returns({ paths: ['/test4999'] })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
    })
  })

  describe('MISSING_ROUTE decision', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, DD_API_SECURITY_SAMPLE_DELAY: 30 } } })
    })

    it('returns MISSING_ROUTE when there is no route and status is not 404 and response is not blocked', () => {
      webStub.getContext.returns({ paths: [], span: { context: () => ({ _tags: {} }) } })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.MISSING_ROUTE)
    })

    it('returns SKIP (not MISSING_ROUTE) on 404 routeless responses', () => {
      webStub.getContext.returns({ paths: [], span: { context: () => ({ _tags: {} }) } })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, { statusCode: 404 }, true), SamplingDecision.SKIP)
    })

    it('returns SKIP (not MISSING_ROUTE) on blocked routeless responses', () => {
      webStub.getContext.returns({ paths: [], span: { context: () => ({ _tags: {} }) } })
      blockingStub.isBlocked.returns(true)

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
    })

    it('returns SKIP (not MISSING_ROUTE) when priority is rejected', () => {
      span.context.returns({ _sampling: { priority: AUTO_REJECT } })
      webStub.getContext.returns({ paths: [], span: { context: () => ({ _tags: {} }) } })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
    })

    it('does not record routeless requests in the TTL cache (missing_route ignores TTL)', () => {
      webStub.getContext.returns({ paths: [], span: { context: () => ({ _tags: {} }) } })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.MISSING_ROUTE)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.MISSING_ROUTE)
    })
  })

  describe('ASM Standalone', () => {
    let keepTraceStub

    beforeEach(() => {
      keepTraceStub = sinon.stub()
      apiSecuritySampler = proxyquire('../../../src/appsec/api_security/sampler', {
        '../../plugins/util/web': webStub,
        '../blocking': blockingStub,
        '../../priority_sampler': {
          keepTrace: keepTraceStub,
        },
        '../../standalone/product': {
          ASM: 'asm',
        },
      })
      SamplingDecision = apiSecuritySampler.SamplingDecision
      apiSecuritySampler.configure({
        appsec: {
          apiSecurity: {
            enabled: true,
            DD_API_SECURITY_SAMPLE_DELAY: 30,
          },
        },
        apmTracingEnabled: false,
      })
    })

    it('should keep trace with ASM product when in standalone mode', () => {
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
      assert.strictEqual(keepTraceStub.calledWith(span, 'asm'), true)
    })

    it('should not check priority sampling in standalone mode', () => {
      span.context.returns({ _sampling: { priority: AUTO_REJECT } })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
      assert.strictEqual(keepTraceStub.calledWith(span, 'asm'), true)
    })
  })

  describe('http.endpoint fallback', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ appsec: { apiSecurity: { enabled: true, DD_API_SECURITY_SAMPLE_DELAY: 30 } } })
    })

    function makeSpan (tags) {
      return {
        context: sinon.stub().returns({
          _sampling: { priority: AUTO_KEEP },
          _tags: tags,
          getTag: (key) => tags[key],
          getTags: () => tags,
          setTag: (key, value) => { tags[key] = value },
          hasTag: (key) => key in tags,
        }),
      }
    }

    it('samples a routeless request when http.endpoint is available and status is not 404', () => {
      const spanWithEndpoint = makeSpan({ 'http.endpoint': '/api/users' })
      webStub.root.returns(spanWithEndpoint)
      webStub.getContext.returns({ paths: [], span: spanWithEndpoint })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), true)
      // Subsequent call hits TTL: confirms the endpoint key was recorded
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
    })

    it('does not use http.endpoint as fallback for 404 responses', () => {
      const res404 = { statusCode: 404 }
      const spanWithEndpoint = makeSpan({ 'http.endpoint': '/api/users' })
      webStub.root.returns(spanWithEndpoint)
      webStub.getContext.returns({ paths: [], span: spanWithEndpoint })

      // Empty route + 404 => SKIP (not MISSING_ROUTE, since 404 is excluded)
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res404, true), SamplingDecision.SKIP)
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res404), false)
    })

    it('prefers http.route over http.endpoint: two requests sharing http.route hit the same TTL slot', () => {
      const spanWithBoth = makeSpan({ 'http.endpoint': '/api/users' })
      webStub.root.returns(spanWithBoth)
      webStub.getContext.returns({ paths: ['/users/:id'], span: spanWithBoth })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      // Same http.route but different http.endpoint; should share the TTL slot
      const spanWithDifferentEndpoint = {
        context: sinon.stub().returns({
          _sampling: { priority: AUTO_KEEP },
          _tags: { 'http.endpoint': '/api/other' },
        }),
      }
      webStub.root.returns(spanWithDifferentEndpoint)
      webStub.getContext.returns({ paths: ['/users/:id'], span: spanWithDifferentEndpoint })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SKIP)
    })

    it('returns MISSING_ROUTE when neither http.route nor http.endpoint is available', () => {
      const spanWithoutEndpoint = makeSpan({})
      webStub.root.returns(spanWithoutEndpoint)
      webStub.getContext.returns({ paths: [], span: spanWithoutEndpoint })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.MISSING_ROUTE)
    })

    it('handles missing span on the request context gracefully', () => {
      webStub.getContext.returns({ paths: [], span: null })

      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.MISSING_ROUTE)
    })

    it('samples different http.endpoint values independently', () => {
      const span1 = makeSpan({ 'http.endpoint': '/api/users' })
      const span2 = makeSpan({ 'http.endpoint': '/api/products' })

      webStub.root.returns(span1)
      webStub.getContext.returns({ paths: [], span: span1 })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      webStub.root.returns(span2)
      webStub.getContext.returns({ paths: [], span: span2 })
      assert.strictEqual(apiSecuritySampler.sampleRequest(req, res, true), SamplingDecision.SAMPLE)

      // Both endpoints still recorded in TTL independently
      webStub.getContext.returns({ paths: [], span: span1 })
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), true)
      webStub.getContext.returns({ paths: [], span: span2 })
      assert.strictEqual(apiSecuritySampler.wasSampled(req, res), true)
    })
  })
})
