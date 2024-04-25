'use strict'

const apiSecuritySampler = require('../../src/appsec/api_security_sampler')

describe('Api Security Sampler', () => {
  let config
  const req = {
    url: '/test',
    method: 'GET'
  }
  const res = {
    statusCode: 200
  }

  beforeEach(() => {
    config = {
      apiSecurity: {
        enabled: true,
        sampleCacheSize: 2
      }
    }
  })

  afterEach(sinon.restore)

  describe('sampleRequest', () => {
    it('should sample unknown request', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true
    })

    it('should sample multiple requests based on url, method and statusCode', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true
      expect(apiSecuritySampler.sampleRequest(req, { statusCode: 500 })).to.true
    })

    it('should sample multiple requests based on url, method and statusCode II', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true
      expect(apiSecuritySampler.sampleRequest({ url: '/otherTest', method: 'POST' }, res)).to.true
    })

    it('should not sample repeated requests in the configured interval', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true
      expect(apiSecuritySampler.sampleRequest(req, res)).to.false
    })

    it('should sample repeated request after interval', () => {
      const clock = sinon.useFakeTimers()

      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true

      clock.tick(40000)

      expect(apiSecuritySampler.has(req, res)).to.false

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true

      clock.restore()
    })

    it('should mantain a max size cache', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest(req, res)).to.true
      expect(apiSecuritySampler.sampleRequest(req, { statusCode: 500 })).to.true
      expect(apiSecuritySampler.sampleRequest(req, { statusCode: 404 })).to.true

      expect(apiSecuritySampler.has(req, res)).to.false
      expect(apiSecuritySampler.has(req, { statusCode: 500 })).to.true
    })
  })
})
