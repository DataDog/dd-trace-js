'use strict'

const proxyquire = require('proxyquire')
const { assert } = require('chai')
const { performance } = require('node:perf_hooks')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

describe('API Security Sampler', () => {
  const req = { route: { path: '/test' }, method: 'GET' }
  const res = { statusCode: 200 }
  let apiSecuritySampler, webStub, span, clock, performanceNowStub

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 10 })
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

    apiSecuritySampler.configure({ apiSecurity: { enabled: true, sampleDelay: 30 } })

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
    assert.isFalse(apiSecuritySampler.sampleRequest({}, {}))
  })

  it('should return false if no root span', () => {
    webStub.root.returns(null)
    assert.isFalse(apiSecuritySampler.sampleRequest({}, {}))
  })

  it('should return false for AUTO_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: AUTO_REJECT } })
    assert.isFalse(apiSecuritySampler.sampleRequest(req, res))
  })

  it('should return false for USER_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: USER_REJECT } })
    assert.isFalse(apiSecuritySampler.sampleRequest(req, res))
  })

  it('should sample for AUTO_KEEP priority without checking prioritySampler', () => {
    span.context.returns({ _sampling: { priority: AUTO_KEEP } })
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res))
  })

  it('should sample for USER_KEEP priority without checking prioritySampler', () => {
    span.context.returns({ _sampling: { priority: USER_KEEP } })
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res))
  })

  it('should not sample before 30 seconds', () => {
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res, true))

    clock.tick(25000)

    assert.isFalse(apiSecuritySampler.sampleRequest(req, res, true))

    assert.isTrue(apiSecuritySampler.isSampled(req, res))
  })

  it('should sample after 30 seconds', () => {
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res, true))

    clock.tick(35000)

    assert.isTrue(apiSecuritySampler.sampleRequest(req, res, true))
  })

  it('should remove oldest entry when max size is exceeded', () => {
    for (let i = 0; i < 4097; i++) {
      const path = `/test${i}`
      webStub.getContext.returns({ paths: [path] })
      assert.isTrue(apiSecuritySampler.sampleRequest(req, res, true))
    }
    webStub.getContext.returns({ paths: ['/test0'] })
    assert.isFalse(apiSecuritySampler.isSampled(req, res))
    webStub.getContext.returns({ paths: ['/test4096'] })
    assert.isTrue(apiSecuritySampler.isSampled(req, res))
  })

  it('should set enabled to false and clear the cache', () => {
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res, true))

    apiSecuritySampler.disable()

    assert.isFalse(apiSecuritySampler.sampleRequest(req, res, true))
  })

  it('should create different keys for different methods', () => {
    const getReq = { method: 'GET' }
    const postReq = { method: 'POST' }
    assert.isTrue(apiSecuritySampler.sampleRequest(getReq, res, true))
    assert.isTrue(apiSecuritySampler.sampleRequest(postReq, res, true))
    assert.isTrue(apiSecuritySampler.isSampled(getReq, res))
    assert.isTrue(apiSecuritySampler.isSampled(postReq, res))
  })

  it('should create different keys for different status codes', () => {
    const res200 = { statusCode: 200 }
    const res404 = { statusCode: 404 }

    assert.isTrue(apiSecuritySampler.sampleRequest(req, res200, true))
    assert.isTrue(apiSecuritySampler.sampleRequest(req, res404, true))
    assert.isTrue(apiSecuritySampler.isSampled(req, res200))
    assert.isTrue(apiSecuritySampler.isSampled(req, res404))
  })

  it('should not sample when method or statusCode is not available', () => {
    assert.isFalse(apiSecuritySampler.sampleRequest(req, {}, true))
    assert.isFalse(apiSecuritySampler.sampleRequest({}, res, true))
  })
})
