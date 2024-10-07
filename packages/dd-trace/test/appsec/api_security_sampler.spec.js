'use strict'

const { performance } = require('node:perf_hooks')
const proxyquire = require('proxyquire')

describe('API Security Sampler', () => {
  const req = { url: '/test', method: 'GET' }
  const res = { statusCode: 200 }
  let apiSecuritySampler, performanceNowStub, webStub, sampler, span

  beforeEach(() => {
    performanceNowStub = sinon.stub(performance, 'now').returns(0)

    webStub = { root: sinon.stub() }

    sampler = sinon.stub().returns({
      isSampled: sinon.stub()
    })

    apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
      '../plugins/util/web': webStub,
      '../priority_sampler': sampler
    })

    apiSecuritySampler.configure({ apiSecurity: { enabled: true } })

    span = {
      context: sinon.stub().returns({})
    }

    webStub.root.returns(span)
    sampler().isSampled.returns(true)

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

  it('should return true and put request in cache if priority is AUTO_KEEP or USER_KEEP', () => {
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
  })

  it('should not sample before 30 seconds', () => {
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
    performanceNowStub.returns(performance.now() + 25000)

    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.false
    expect(apiSecuritySampler.isSampled(req, res)).to.be.true
  })

  it('should sample after 30 seconds', () => {
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true

    performanceNowStub.returns(performance.now() + 35000)

    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
  })

  it('should return false if priority is neither AUTO_KEEP nor USER_KEEP', () => {
    sampler().isSampled.returns(false)
    expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
  })

  it('should remove oldest entry when max size is exceeded', () => {
    const method = req.method
    for (let i = 0; i < 4097; i++) {
      expect(apiSecuritySampler.sampleRequest({ method, url: `/test${i}` }, res)).to.be.true
    }

    expect(apiSecuritySampler.isSampled({ method, url: '/test0' }, res)).to.be.false
    expect(apiSecuritySampler.isSampled({ method, url: '/test4096' }, res)).to.be.true
  })

  it('should set enabled to false and clear the cache', () => {
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true

    apiSecuritySampler.disable()

    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.false
  })
})
