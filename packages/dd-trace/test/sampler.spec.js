'use strict'

require('./setup/core')

describe('Sampler', () => {
  let Sampler
  let sampler

  beforeEach(() => {
    sinon.stub(Math, 'random')
    Sampler = require('../src/sampler')
  })

  afterEach(() => {
    Math.random.restore()
  })

  describe('rate', () => {
    it('should return the sample rate', () => {
      sampler = new Sampler(0.5)

      expect(sampler.rate()).to.equal(0.5)
    })
  })

  describe('isSampled', () => {
    it('should always sample when rate is 1', () => {
      sampler = new Sampler(1)

      Math.random.returns(0.9999999999999999)

      expect(sampler.isSampled()).to.be.true
    })

    it('should never sample when rate is 0', () => {
      sampler = new Sampler(0)

      Math.random.returns(0)

      expect(sampler.isSampled()).to.be.false
    })

    it('should sample according to the rate', () => {
      sampler = new Sampler(0.1234)

      Math.random.returns(0.1233999999999999)

      expect(sampler.isSampled()).to.be.true

      Math.random.returns(0.1234)

      expect(sampler.isSampled()).to.be.false
    })
  })
})
