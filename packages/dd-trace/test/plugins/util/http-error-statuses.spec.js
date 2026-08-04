'use strict'

const assert = require('node:assert/strict')

const { getStatusValidator, parseStatusRanges } = require('../../../src/plugins/util/http-error-statuses')

describe('http-error-statuses', () => {
  describe('parseStatusRanges', () => {
    it('parses a single range', () => {
      assert.deepStrictEqual(parseStatusRanges('500-599', 'TEST'), [[500, 599]])
    })

    it('parses a mix of ranges and single codes, ignoring surrounding space', () => {
      assert.deepStrictEqual(parseStatusRanges('400-499, 503 ,429', 'TEST'), [[400, 499], [503, 503], [429, 429]])
    })

    it('drops an inverted range and a non-numeric entry', () => {
      assert.deepStrictEqual(parseStatusRanges('599-500,abc,404', 'TEST'), [[404, 404]])
    })

    it('returns undefined when nothing is parseable', () => {
      assert.strictEqual(parseStatusRanges('nonsense', 'TEST'), undefined)
      assert.strictEqual(parseStatusRanges('', 'TEST'), undefined)
    })
  })

  describe('getStatusValidator', () => {
    // validateStatus returns true when the code is NOT an error.
    it('defaults server spans to 5xx', () => {
      const validate = getStatusValidator({}, 'server')

      assert.strictEqual(validate(200), true)
      assert.strictEqual(validate(404), true)
      // Pin both edges of the range.
      assert.strictEqual(validate(499), true)
      assert.strictEqual(validate(500), false)
      assert.strictEqual(validate(599), false)
      assert.strictEqual(validate(600), true)
    })

    it('defaults client spans to 4xx', () => {
      const validate = getStatusValidator({}, 'client')

      assert.strictEqual(validate(399), true)
      assert.strictEqual(validate(400), false)
      assert.strictEqual(validate(499), false)
      assert.strictEqual(validate(500), true)
    })

    it('widens the client default to 4xx-5xx when OTel semantics are enabled', () => {
      // OTel treats a client 5xx as an error; Datadog historically did not.
      const validate = getStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'client')

      assert.strictEqual(validate(399), true)
      assert.strictEqual(validate(400), false)
      assert.strictEqual(validate(503), false)
      assert.strictEqual(validate(599), false)
      assert.strictEqual(validate(600), true)
    })

    it('leaves the server default alone when OTel semantics are enabled', () => {
      const validate = getStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'server')

      assert.strictEqual(validate(404), true)
      assert.strictEqual(validate(500), false)
    })

    it('honors the configured server range', () => {
      const validate = getStatusValidator({ DD_TRACE_HTTP_SERVER_ERROR_STATUSES: '500-599,404' }, 'server')

      assert.strictEqual(validate(404), false)
      assert.strictEqual(validate(403), true)
      assert.strictEqual(validate(500), false)
    })

    it('honors the configured client range', () => {
      const validate = getStatusValidator({ DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '429' }, 'client')

      assert.strictEqual(validate(429), false)
      assert.strictEqual(validate(404), true)
      assert.strictEqual(validate(503), true)
    })

    it('lets the configured client range win over the OTel widening', () => {
      const validate = getStatusValidator({
        DD_TRACE_HTTP_CLIENT_ERROR_STATUSES: '400-499',
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
      }, 'client')

      assert.strictEqual(validate(404), false)
      assert.strictEqual(validate(503), true)
    })

    it('lets a plugin-level validateStatus function win over everything', () => {
      const custom = () => false
      const config = {
        validateStatus: custom,
        DD_TRACE_HTTP_SERVER_ERROR_STATUSES: '500-599',
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
      }

      assert.strictEqual(getStatusValidator(config, 'server'), custom)
    })

    it('treats every status as a non-error when the configured range is unusable', () => {
      const validate = getStatusValidator({ DD_TRACE_HTTP_SERVER_ERROR_STATUSES: 'nonsense' }, 'server')

      assert.strictEqual(validate(500), true)
    })
  })
})
