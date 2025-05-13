'use strict'

require('./setup/tap')

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

  describe('threshold', () => {
    it('should calculate the correct threshold for a given rate', () => {
      const rates = [
        [0.2, 3689348814741910528n],
        [0.25, 4611686018427387904n],
        [0.3333, 6148299799767393280n],
        [0.5, 9223372036854775808n],
        [0.75, 13835058055282163712n],
        [0.9, 16602069666338596864n],
        [0.95, 17524406870024073216n]
      ]

      rates.forEach(([rate, expected]) => {
        sampler = new Sampler(rate)
        expect(sampler._threshold).to.equal(expected)
      })
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
