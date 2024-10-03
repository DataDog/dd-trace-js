'use strict'

const proxyquire = require('proxyquire')

describe('API Security Sampler', () => {
  let apiSecuritySampler, webStub, clock

  beforeEach(() => {
    webStub = { root: sinon.stub() }
    clock = sinon.useFakeTimers(Date.now())

    apiSecuritySampler = proxyquire('../../src/appsec/api_security_sampler', {
      '../plugins/util/web': webStub
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('sampleRequest', () => {
    beforeEach(() => {
      apiSecuritySampler.configure({ apiSecurity: { enabled: true, sampleDelay: 30 } })
    })

    it('should return false if not enabled', () => {
      apiSecuritySampler.disable()
      expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
    })

    it('should return false if no root span', () => {
      webStub.root.returns(null)
      expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
    })

    it('should return true and put request in cache if priority is AUTO_KEEP', () => {
      const rootSpan = { context: () => ({ _sampling: { priority: 2 } }) }
      webStub.root.returns(rootSpan)
      const req = { url: '/test', method: 'GET' }
      const res = { statusCode: 200 }
      expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
    })

    it('should return true and put request in cache if priority is USER_KEEP', () => {
      const rootSpan = { context: () => ({ _sampling: { priority: 1 } }) }
      webStub.root.returns(rootSpan)
      const req = { url: '/test', method: 'GET' }
      const res = { statusCode: 200 }
      expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true
    })

    it('should return false if priority is neither AUTO_KEEP nor USER_KEEP', () => {
      const rootSpan = { context: () => ({ _sampling: { priority: 0 } }) }
      webStub.root.returns(rootSpan)
      expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
    })
  })

  describe('disable', () => {
    it('should set enabled to false and clear the cache', () => {
      const req = { url: '/test', method: 'GET' }
      const res = { statusCode: 200 }

      const rootSpan = { context: () => ({ _sampling: { priority: 2 } }) }
      webStub.root.returns(rootSpan)

      apiSecuritySampler.configure({ apiSecurity: { enabled: true, sampleDelay: 30 } })
      expect(apiSecuritySampler.sampleRequest(req, res)).to.be.true

      apiSecuritySampler.disable()

      expect(apiSecuritySampler.sampleRequest({}, {})).to.be.false
    })
  })
})
