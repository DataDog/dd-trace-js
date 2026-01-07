'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const RateLimiter = require('../../src/rate_limiter')

describe('Disabled APM Tracing or Standalone - Product', () => {
  let getProductRateLimiter

  beforeEach(() => {
    getProductRateLimiter = proxyquire('../../src/standalone/product', {
      '../rate_limiter': sinon.stub(RateLimiter.prototype, 'constructor').callsFake((limit, interval = 'second') => {
        return {
          limit,
          interval
        }
      })

    }).getProductRateLimiter
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('getProductRateLimiter', () => {
    it('should return a drop all traces rateLimiter by default', () => {
      const rateLimiter = getProductRateLimiter({})
      assert.strictEqual(rateLimiter.limit, 0)
      assert.strictEqual(rateLimiter.interval, 'second')
    })

    it('should return a 1req/min rateLimiter when appsec is enabled', () => {
      const rateLimiter = getProductRateLimiter({ appsec: { enabled: true } })
      assert.strictEqual(rateLimiter.limit, 1)
      assert.strictEqual(rateLimiter.interval, 'minute')
    })

    it('should return a 1req/min rateLimiter when iast is enabled', () => {
      const rateLimiter = getProductRateLimiter({ iast: { enabled: true } })
      assert.strictEqual(rateLimiter.limit, 1)
      assert.strictEqual(rateLimiter.interval, 'minute')
    })
  })
})
