'use strict'

const proxyquire = require('proxyquire')

describe('API Security Sampler', () => {
  let apiSecuritySampler, webStub, clock, sampler, span

  beforeEach(() => {
    webStub = { root: sinon.stub() }
    clock = sinon.useFakeTimers(Date.now())

    sampler = sinon.stub().returns({
      isSampled: sinon.stub()
    })

    apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
      '../plugins/util/web': webStub,
      '../priority_sampler': sampler
    })

    apiSecuritySampler.configure({ apiSecurity: { enabled: true, sampleDelay: 30 } })

    span = {
      context: sinon.stub().returns({})
    }
  })

  afterEach(() => {
    clock.restore()
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
    webStub.root.returns(span)
    sampler().isSampled.returns(true)
    const req = { url: '/test', method: 'GET' }
    const res = { statusCode: 200 }
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
  })

  it('should return false if priority is neither AUTO_KEEP nor USER_KEEP', () => {
    webStub.root.returns(span)
    sampler().isSampled.returns(false)
    expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
  })

  it('should set enabled to false and clear the cache', () => {
    const req = { url: '/test', method: 'GET' }
    const res = { statusCode: 200 }

    webStub.root.returns(span)
    sampler().isSampled.returns(true)

    apiSecuritySampler.configure({ apiSecurity: { enabled: true, sampleDelay: 30 } })
    expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true

    apiSecuritySampler.disable()

    expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
  })
})
