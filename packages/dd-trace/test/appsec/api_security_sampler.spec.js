'use strict'

const { performance } = require('node:perf_hooks')
const proxyquire = require('proxyquire')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

describe('API Security Sampler', () => {
  const req = { route: { path: '/test' }, method: 'GET' }
  const res = { statusCode: 200 }
  let apiSecuritySampler, performanceNowStub, webStub, span

  beforeEach(() => {
    performanceNowStub = sinon.stub(performance, 'now').returns(0)

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

    apiSecuritySampler.configure({ apiSecurity: { enabled: true } })

    span = {
      context: sinon.stub().returns({
        _sampling: { priority: AUTO_KEEP }
      })
    }

    webStub.root.returns(span)
    webStub.getContext.returns({ paths: ['path'] })

    performanceNowStub.returns(performance.now() + 1)
  })

  afterEach(() => {
    performanceNowStub.restore()
    apiSecuritySampler.disable()
  })

  it('should return false if not enabled', () => {
    apiSecuritySampler.disable()
    expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
  })

  it('should return false if no root span', () => {
    webStub.root.returns(null)
    expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
  })

  it('should return false for AUTO_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: AUTO_REJECT } })
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.false
  })

  it('should return false for USER_REJECT priority', () => {
    span.context.returns({ _sampling: { priority: USER_REJECT } })
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.false
  })

  it('should sample for AUTO_KEEP priority without checking prioritySampler', () => {
    span.context.returns({ _sampling: { priority: AUTO_KEEP } })
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
  })

  it('should sample for USER_KEEP priority without checking prioritySampler', () => {
    span.context.returns({ _sampling: { priority: USER_KEEP } })
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
  })

  it('should not sample before 30 seconds', () => {
    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.true
    performanceNowStub.returns(performance.now() + 25000)

    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.false
    expect(apiSecuritySampler.isSampled(req, res)).to.be.true
  })

  it('should sample after 30 seconds', () => {
    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.true

    performanceNowStub.returns(performance.now() + 35000)

    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.true
  })

  it('should remove oldest entry when max size is exceeded', () => {
    for (let i = 0; i < 4097; i++) {
      const path = `/test${i}`
      webStub.getContext.returns({ paths: [path] })
      expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.true
    }
    webStub.getContext.returns({ paths: ['/test0'] })
    expect(apiSecuritySampler.isSampled(req, res)).to.be.false
    webStub.getContext.returns({ paths: ['/test4096'] })
    expect(apiSecuritySampler.isSampled(req, res)).to.be.true
  })

  it('should set enabled to false and clear the cache', () => {
    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.true

    apiSecuritySampler.disable()

    expect(apiSecuritySampler.sampleRequest(req, res, true)).to.be.false
  })

  it('should create different keys for different methods', () => {
    const getReq = { method: 'GET' }
    const postReq = { method: 'POST' }
    expect(apiSecuritySampler.sampleRequest(getReq, res, true)).to.be.true
    expect(apiSecuritySampler.sampleRequest(postReq, res, true)).to.be.true
    expect(apiSecuritySampler.isSampled(getReq, res)).to.be.true
    expect(apiSecuritySampler.isSampled(postReq, res)).to.be.true
  })

  it('should create different keys for different status codes', () => {
    const res200 = { statusCode: 200 }
    const res404 = { statusCode: 404 }

    expect(apiSecuritySampler.sampleRequest(req, res200, true)).to.be.true
    expect(apiSecuritySampler.sampleRequest(req, res404, true)).to.be.true
    expect(apiSecuritySampler.isSampled(req, res200)).to.be.true
    expect(apiSecuritySampler.isSampled(req, res404)).to.be.true
  })

  it('should not sample when method or statusCode is not available', () => {
    expect(apiSecuritySampler.sampleRequest(req, {}, true)).to.be.false
    expect(apiSecuritySampler.sampleRequest({}, res, true)).to.be.false
  })
})
