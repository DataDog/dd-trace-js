'use strict'

const t = require('tap')
require('./setup/core')

t.test('RandomSampler', t => {
  let RandomSampler
  let sampler

  t.beforeEach(() => {
    sinon.stub(Math, 'random')
    RandomSampler = require('../src/random_sampler')
  })

  t.afterEach(() => {
    Math.random.restore()
  })

  t.test('rate', t => {
    t.test('should return the sample rate', t => {
      sampler = new RandomSampler(0.5)

      expect(sampler.rate()).to.equal(0.5)
      t.end()
    })
    t.end()
  })

  t.test('isSampled', t => {
    t.test('should always sample when rate is 1', t => {
      sampler = new RandomSampler(1)

      Math.random.returns(0.9999999999999999)

      expect(sampler.isSampled()).to.be.true
      t.end()
    })

    t.test('should never sample when rate is 0', t => {
      sampler = new RandomSampler(0)

      Math.random.returns(0)

      expect(sampler.isSampled()).to.be.false
      t.end()
    })

    t.test('should sample according to the rate', t => {
      sampler = new RandomSampler(0.1234)

      Math.random.returns(0.1233999999999999)

      expect(sampler.isSampled()).to.be.true

      Math.random.returns(0.1234)

      expect(sampler.isSampled()).to.be.false
      t.end()
    })
    t.end()
  })
  t.end()
})
