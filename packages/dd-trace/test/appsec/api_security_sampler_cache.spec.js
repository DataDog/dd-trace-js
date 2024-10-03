'use strict'

const ApiSecuritySamplerCache = require('../../src/appsec/api_security_sampler_cache')

describe('ApiSecuritySamplerCache', () => {
  let cache
  let clock

  beforeEach(() => {
    cache = new ApiSecuritySamplerCache()
    clock = sinon.useFakeTimers(Date.now())
  })

  afterEach(() => {
    clock.restore()
  })

  describe('Standard behavior with default delay', () => {
    it('should not sample when first seen', () => {
      const req = { url: '/test', method: 'GET' }
      const res = { status_code: 200 }
      const key = cache.computeKey(req, res)
      expect(cache.isSampled(key)).to.be.false
    })

    it('should sample within 30 seconds of first seen', () => {
      const req = { url: '/test', method: 'GET' }
      const res = { status_code: 200 }
      const key = cache.computeKey(req, res)
      cache.set(key)
      clock.tick(29000)
      expect(cache.isSampled(key)).to.be.true
    })

    it('should not sample after 30 seconds', () => {
      const req = { url: '/test', method: 'GET' }
      const res = { status_code: 200 }
      const key = cache.computeKey(req, res)
      cache.set(key)
      clock.tick(31000)
      expect(cache.isSampled(key)).to.be.false
    })
  })

  describe('Max size behavior', () => {
    it('should remove oldest entry when max size is exceeded', () => {
      const baseReq = { method: 'GET' }
      const baseRes = { status_code: 200 }

      for (let i = 0; i < 4097; i++) {
        const req = { ...baseReq, url: `test${i}` }
        const key = cache.computeKey(req, baseRes)
        cache.set(key)
      }

      expect(cache.size).to.equal(4096)

      const firstKey = cache.computeKey({ ...baseReq, url: 'test0' }, baseRes)
      expect(cache.isSampled(firstKey)).to.be.false

      const lastKey = cache.computeKey({ ...baseReq, url: 'test4096' }, baseRes)
      expect(cache.isSampled(lastKey)).to.be.true
    })
  })
})
