'use strict'

require('../setup/tap')

const { assert } = require('chai')
const proxyquire = require('proxyquire')
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
      assert.propertyVal(rateLimiter, 'limit', 0)
      assert.propertyVal(rateLimiter, 'interval', 'second')
    })

    it('should return a 1req/min rateLimiter when appsec is enabled', () => {
      const rateLimiter = getProductRateLimiter({ appsec: { enabled: true } })
      assert.propertyVal(rateLimiter, 'limit', 1)
      assert.propertyVal(rateLimiter, 'interval', 'minute')
    })

    it('should return a 1req/min rateLimiter when iast is enabled', () => {
      const rateLimiter = getProductRateLimiter({ iast: { enabled: true } })
      assert.propertyVal(rateLimiter, 'limit', 1)
      assert.propertyVal(rateLimiter, 'interval', 'minute')
    })
  })
})
