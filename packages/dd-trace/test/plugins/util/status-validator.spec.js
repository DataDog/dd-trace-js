'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const { getClientStatusValidator, getServerStatusValidator } = require('../../../src/plugins/util/status-validator')

describe('plugins/util/status-validator', () => {
  describe('getClientStatusValidator', () => {
    it('should mark 4xx as errors by default', () => {
      const validateStatus = getClientStatusValidator({})

      assert.strictEqual(validateStatus(399), true)
      assert.strictEqual(validateStatus(400), false)
      assert.strictEqual(validateStatus(499), false)
      assert.strictEqual(validateStatus(500), true)
    })

    it('should mark configured HTTP client status codes as errors', () => {
      const validateStatus = getClientStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: ' 200 - 201, 202, 250-249 ',
      })

      assert.strictEqual(validateStatus(199), true)
      assert.strictEqual(validateStatus(200), false)
      assert.strictEqual(validateStatus(201), false)
      assert.strictEqual(validateStatus(202), false)
      assert.strictEqual(validateStatus(203), true)
      assert.strictEqual(validateStatus(248), true)
      assert.strictEqual(validateStatus(249), false)
      assert.strictEqual(validateStatus(250), false)
      assert.strictEqual(validateStatus(251), true)
      assert.strictEqual(validateStatus(400), true)
    })

    it('should combine overlapping HTTP client status code ranges', () => {
      const validateStatus = getClientStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '250-300,420,240-260',
      })

      assert.strictEqual(validateStatus(239), true)
      assert.strictEqual(validateStatus(240), false)
      assert.strictEqual(validateStatus(255), false)
      assert.strictEqual(validateStatus(420), false)
    })

    it('should only configure valid HTTP status codes', () => {
      const validateStatus = getClientStatusValidator({ DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '100,599' })

      assert.strictEqual(validateStatus(100), false)
      assert.strictEqual(validateStatus(599), false)
    })

    for (const value of ['400-499', ' 400 - 499 ']) {
      it(`should apply the explicit default-shaped range ${JSON.stringify(value)}`, () => {
        const validateStatus = getClientStatusValidator({ DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: value })

        assert.strictEqual(validateStatus(399), true)
        assert.strictEqual(validateStatus(400), false)
        assert.strictEqual(validateStatus(499), false)
        assert.strictEqual(validateStatus(500), true)
      })
    }

    for (const value of ['', '99', '600', '99-100', '599-600', '600-599', '200,,202', '200-', 400]) {
      it(`should use the default HTTP client error statuses for ${JSON.stringify(value)}`, () => {
        const validateStatus = getClientStatusValidator({ DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: value })

        assert.strictEqual(validateStatus(399), true)
        assert.strictEqual(validateStatus(400), false)
        assert.strictEqual(validateStatus(499), false)
        assert.strictEqual(validateStatus(500), true)
      })
    }

    it('should prefer a `validateStatus` function over the configured statuses', () => {
      const validateStatus = getClientStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '200',
        validateStatus: code => code === 200,
      })

      assert.strictEqual(validateStatus(200), true)
      assert.strictEqual(validateStatus(400), false)
    })

    it('should apply configured HTTP client error statuses when validateStatus is invalid', () => {
      const validateStatus = getClientStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '200',
        validateStatus: true,
      })

      assert.strictEqual(validateStatus(200), false)
      assert.strictEqual(validateStatus(400), true)
    })
  })

  describe('with OTel semantics enabled', () => {
    const errorCodes = (validate, codes) => codes.filter((code) => !validate(code))

    it('should extend the client range to 5xx, both boundaries pinned', () => {
      const validate = getClientStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true })

      assert.deepStrictEqual(errorCodes(validate, [200, 399, 400, 499, 500, 599]), [400, 499, 500, 599])
    })

    it('should keep a status above 599 an error', () => {
      const validate = getClientStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true })

      assert.deepStrictEqual(errorCodes(validate, [599, 600, 999]), [599, 600, 999])
    })

    it('should preserve an explicitly configured default-shaped client range', () => {
      const validate = getClientStatusValidator({
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '400-499',
      })

      assert.deepStrictEqual(errorCodes(validate, [399, 400, 499, 500, 599]), [400, 499])
    })

    it('should let a configured client range take precedence over the OTel default', () => {
      const validate = getClientStatusValidator({
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '200',
      })

      assert.deepStrictEqual(errorCodes(validate, [200, 404, 500]), [200])
    })

    it('should bound an explicitly configured OTel-shaped client range at 599', () => {
      const validate = getClientStatusValidator({
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '400-599',
      })

      assert.deepStrictEqual(errorCodes(validate, [399, 400, 599, 600]), [400, 599])
    })
  })

  describe('getServerStatusValidator', () => {
    it('should mark 5xx as errors by default', () => {
      const validateStatus = getServerStatusValidator({})

      assert.strictEqual(validateStatus(400), true)
      assert.strictEqual(validateStatus(499), true)
      assert.strictEqual(validateStatus(500), false)
      assert.strictEqual(validateStatus(599), false)
      assert.strictEqual(validateStatus(600), false)
    })

    for (const range of ['500-599', ' 500 - 599 ']) {
      it(`should use the configured server range ${JSON.stringify(range)}`, () => {
        const validateStatus = getServerStatusValidator({ DD_TRACE_HTTP_SERVER_ERROR_STATUSES: range })

        assert.strictEqual(validateStatus(499), true)
        assert.strictEqual(validateStatus(500), false)
        assert.strictEqual(validateStatus(599), false)
        assert.strictEqual(validateStatus(600), true)
        assert.strictEqual(validateStatus(999), true)
      })
    }

    it('should not be affected by the client error statuses', () => {
      const validateStatus = getServerStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '200',
        DD_TRACE_HTTP_SERVER_ERROR_STATUSES: '201',
      })

      assert.strictEqual(validateStatus(200), true)
      assert.strictEqual(validateStatus(201), false)
      assert.strictEqual(validateStatus(500), true)
    })
  })
})
