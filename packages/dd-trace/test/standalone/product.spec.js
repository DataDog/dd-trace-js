'use strict'

const t = require('tap')
require('../setup/core')

const { assert } = require('chai')
const proxyquire = require('proxyquire')
const RateLimiter = require('../../src/rate_limiter')

t.test('Disabled APM Tracing or Standalone - Product', t => {
  let getProductRateLimiter

  t.beforeEach(() => {
    getProductRateLimiter = proxyquire('../../src/standalone/product', {
      '../rate_limiter': sinon.stub(RateLimiter.prototype, 'constructor').callsFake((limit, interval = 'second') => {
        return {
          limit,
          interval
        }
      })

    }).getProductRateLimiter
  })

  t.afterEach(() => {
    sinon.restore()
  })

  t.test('getProductRateLimiter', t => {
    t.test('should return a drop all traces rateLimiter by default', t => {
      const rateLimiter = getProductRateLimiter({})
      assert.propertyVal(rateLimiter, 'limit', 0)
      assert.propertyVal(rateLimiter, 'interval', 'second')
      t.end()
    })

    t.test('should return a 1req/min rateLimiter when appsec is enabled', t => {
      const rateLimiter = getProductRateLimiter({ appsec: { enabled: true } })
      assert.propertyVal(rateLimiter, 'limit', 1)
      assert.propertyVal(rateLimiter, 'interval', 'minute')
      t.end()
    })

    t.test('should return a 1req/min rateLimiter when iast is enabled', t => {
      const rateLimiter = getProductRateLimiter({ iast: { enabled: true } })
      assert.propertyVal(rateLimiter, 'limit', 1)
      assert.propertyVal(rateLimiter, 'interval', 'minute')
      t.end()
    })
    t.end()
  })
  t.end()
})
