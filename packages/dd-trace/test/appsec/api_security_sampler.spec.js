'use strict'

const apiSecuritySampler = require('../../src/appsec/api_security_sampler')

describe('Api Security Sampler', () => {
  let config

  beforeEach(() => {
    config = {
      apiSecurity: {
        enabled: true,
        requestSampling: 1
      }
    }

    sinon.stub(Math, 'random').returns(0.3)
  })

  afterEach(sinon.restore)

  describe('sampleRequest', () => {
    it('should sample request if enabled and sampling 1', () => {
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest({})).to.true
    })

    it('should not sample request if enabled and sampling 0', () => {
      config.apiSecurity.requestSampling = 0
      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest({})).to.false
    })

    it('should sample request if enabled and sampling greater than random', () => {
      config.apiSecurity.requestSampling = 0.5

      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest({})).to.true
    })

    it('should not sample request if enabled and sampling less than random', () => {
      config.apiSecurity.requestSampling = 0.1

      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest()).to.false
    })

    it('should not sample request if incorrect config value', () => {
      config.apiSecurity.requestSampling = NaN

      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest()).to.false
    })

    it('should sample request according to the config', () => {
      config.apiSecurity.requestSampling = 1

      apiSecuritySampler.configure(config)

      expect(apiSecuritySampler.sampleRequest({})).to.true

      apiSecuritySampler.setRequestSampling(0)

      expect(apiSecuritySampler.sampleRequest()).to.false
    })
  })
})
