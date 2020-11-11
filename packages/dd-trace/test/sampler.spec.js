'use strict'

describe('Sampler', () => {
  let Sampler
  let sampler
  let config

  beforeEach(() => {
    config = proxyquire('../src/config', {})
    sinon.stub(Math, 'random')
    Sampler = proxyquire('../src/sampler', {
      './config': config
    })
  })

  afterEach(() => {
    Math.random.restore()
  })

  describe('rate', () => {
    it('should return the sample rate', () => {
      config.configure({ sampleRate: 0.5 })

      sampler = new Sampler()

      expect(sampler.rate()).to.equal(0.5)
    })
  })

  describe('isSampled', () => {
    it('should always sample when rate is 1', () => {
      config.configure({ sampleRate: 1 })

      sampler = new Sampler()

      Math.random.returns(0.9999999999999999)

      expect(sampler.isSampled()).to.be.true
    })

    it('should never sample when rate is 0', () => {
      config.configure({ sampleRate: 0 })

      sampler = new Sampler()

      Math.random.returns(0)

      expect(sampler.isSampled()).to.be.false
    })

    it('should sample according to the rate', () => {
      config.configure({ sampleRate: 0.1234 })

      sampler = new Sampler()

      Math.random.returns(0.1233999999999999)

      expect(sampler.isSampled()).to.be.true

      Math.random.returns(0.1234)

      expect(sampler.isSampled()).to.be.false
    })
  })
})
