'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('./setup/core')

describe('RandomSampler', () => {
  let RandomSampler
  let sampler
  let randomStub

  beforeEach(() => {
    randomStub = sinon.stub(Math, 'random')
    RandomSampler = require('../src/random_sampler')
  })

  afterEach(() => {
    randomStub.restore()
  })

  describe('rate', () => {
    it('should return the sample rate', () => {
      sampler = new RandomSampler(0.5)

      assert.strictEqual(sampler.rate(), 0.5)
    })
  })

  describe('isSampled', () => {
    it('should always sample when rate is 1', () => {
      sampler = new RandomSampler(1)

      randomStub.returns(0.9999999999999999)

      assert.strictEqual(sampler.isSampled(), true)
    })

    it('should never sample when rate is 0', () => {
      sampler = new RandomSampler(0)

      randomStub.returns(0)

      assert.strictEqual(sampler.isSampled(), false)
    })

    it('should sample according to the rate', () => {
      sampler = new RandomSampler(0.1234)

      randomStub.returns(0.1233999999999999)

      assert.strictEqual(sampler.isSampled(), true)

      randomStub.returns(0.1234)

      assert.strictEqual(sampler.isSampled(), false)
    })
  })
})
