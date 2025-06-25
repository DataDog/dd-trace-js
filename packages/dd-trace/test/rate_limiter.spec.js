'use strict'

const t = require('tap')
require('./setup/core')

const RateLimiter = require('../src/rate_limiter')

t.test('RateLimiter', t => {
  let clock
  let rateLimiter

  t.beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  t.afterEach(() => {
    clock.restore()
  })

  t.test('should rate limit', t => {
    rateLimiter = new RateLimiter(2)

    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.false
    t.end()
  })

  t.test('should support disabling the rate limit', t => {
    rateLimiter = new RateLimiter(-1)

    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
    t.end()
  })

  t.test('should support always rejecting', t => {
    rateLimiter = new RateLimiter(0)

    expect(rateLimiter.isAllowed()).to.be.false
    t.end()
  })

  t.test('should reset every second', t => {
    rateLimiter = new RateLimiter(1)

    rateLimiter.isAllowed()

    clock.tick(1000)

    expect(rateLimiter.isAllowed()).to.be.true
    t.end()
  })

  t.test('should calculate its effective rate', t => {
    rateLimiter = new RateLimiter(1)

    expect(rateLimiter.effectiveRate()).to.equal(1)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(1)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(0.5)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(0.3333333333333333)
    t.end()
  })

  t.test('should average its effective rate with the previous rate', t => {
    rateLimiter = new RateLimiter(2)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    clock.tick(1000)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(0.5)
    t.end()
  })

  t.test('should properly reset the counters at each interval', t => {
    rateLimiter = new RateLimiter(2)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    clock.tick(1000)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    clock.tick(1000)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(1)
    t.end()
  })

  t.test('should use 2 intervals to calculate the effective rate', t => {
    rateLimiter = new RateLimiter(2)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    clock.tick(1000)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    clock.tick(1000)

    rateLimiter.isAllowed()
    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(1)
    t.end()
  })

  t.test('should always have an effective rate of 0 when limit is 0', t => {
    rateLimiter = new RateLimiter(0)

    expect(rateLimiter.effectiveRate()).to.equal(0)
    t.end()
  })
  t.end()
})
