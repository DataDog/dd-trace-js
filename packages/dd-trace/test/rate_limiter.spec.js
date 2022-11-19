'use strict'

require('./setup/core')

const RateLimiter = require('../src/rate_limiter')

describe('RateLimiter', () => {
  let clock
  let rateLimiter

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  it('should rate limit', () => {
    rateLimiter = new RateLimiter(2)

    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.false
  })

  it('should support disabling the rate limit', () => {
    rateLimiter = new RateLimiter(-1)

    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
    expect(rateLimiter.isAllowed()).to.be.true
  })

  it('should support always rejecting', () => {
    rateLimiter = new RateLimiter(0)

    expect(rateLimiter.isAllowed()).to.be.false
  })

  it('should reset every second', () => {
    rateLimiter = new RateLimiter(1)

    rateLimiter.isAllowed()

    clock.tick(1000)

    expect(rateLimiter.isAllowed()).to.be.true
  })

  it('should calculate its effective rate', () => {
    rateLimiter = new RateLimiter(1)

    expect(rateLimiter.effectiveRate()).to.equal(1)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(1)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(0.5)

    rateLimiter.isAllowed()

    expect(rateLimiter.effectiveRate()).to.equal(0.3333333333333333)
  })

  it('should average its effective rate with the previous rate', () => {
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
  })

  it('should properly reset the counters at each interval', () => {
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
  })

  it('should use 2 intervals to calculate the effective rate', () => {
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
  })

  it('should always have an effective rate of 0 when limit is 0', () => {
    rateLimiter = new RateLimiter(0)

    expect(rateLimiter.effectiveRate()).to.equal(0)
  })
})
