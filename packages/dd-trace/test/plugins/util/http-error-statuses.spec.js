'use strict'

const assert = require('node:assert/strict')

const { CLIENT, SERVER } = require('../../../../../ext/kinds')
const { getStatusValidator } = require('../../../src/plugins/util/http-error-statuses')

// A validator returns true when the status is *not* an error, so `false` below means "error".
function errorStatuses (validator, codes) {
  return codes.filter(code => !validator(code))
}

describe('http-error-statuses', () => {
  describe('span-kind defaults', () => {
    it('errors a server span on 5xx and above, both boundaries pinned', () => {
      const validate = getStatusValidator({}, SERVER)

      assert.deepStrictEqual(errorStatuses(validate, [199, 200, 399, 400, 499, 500, 599]), [500, 599])
    })

    it('errors a client span on 4xx only by default, both boundaries pinned', () => {
      const validate = getStatusValidator({}, CLIENT)

      assert.deepStrictEqual(errorStatuses(validate, [200, 399, 400, 499, 500, 599]), [400, 499])
    })

    it('errors a client span on 4xx and 5xx under OTel semantics', () => {
      const validate = getStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, CLIENT)

      assert.deepStrictEqual(errorStatuses(validate, [200, 399, 400, 499, 500, 599]), [400, 499, 500, 599])
    })

    // The conventions set the status to Error for 4xx and 5xx "and any other code the client
    // failed to interpret", which is what a status above 599 is. Both kinds stay open above the
    // top of the range, so a 600 cannot be an error on the server span of a request and not on
    // the client span of the same request.
    it('keeps a status above 599 an error for both kinds', () => {
      const server = getStatusValidator({}, SERVER)
      const clientOtel = getStatusValidator({ DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, CLIENT)

      for (const code of [599, 600, 999]) {
        assert.strictEqual(server(code), false, `server ${code} must be an error`)
        assert.strictEqual(clientOtel(code), false, `client ${code} must be an error under the flag`)
      }
    })
  })

  describe('plugin-level validateStatus', () => {
    it('wins over the span-kind default', () => {
      const validateStatus = code => code !== 200
      const validate = getStatusValidator({ validateStatus, DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, CLIENT)

      assert.strictEqual(validate(200), false)
      assert.strictEqual(validate(500), true)
    })

    it('falls back to the default when it is present but not a function', () => {
      const validate = getStatusValidator({ validateStatus: '500-599' }, SERVER)

      assert.deepStrictEqual(errorStatuses(validate, [499, 500]), [500])
    })
  })

  describe('DD_TRACE_HTTP_SERVER_ERROR_STATUSES', () => {
    const forServer = value => getStatusValidator({ DD_TRACE_HTTP_SERVER_ERROR_STATUSES: value }, SERVER)

    it('accepts single codes, ranges and whitespace', () => {
      assert.deepStrictEqual(errorStatuses(forServer('200-201,202'), [199, 200, 201, 202, 203, 500]), [200, 201, 202])
      assert.deepStrictEqual(errorStatuses(forServer(' 404 , 500 '), [403, 404, 405, 500]), [404, 500])
    })

    it('accepts a reversed range', () => {
      assert.deepStrictEqual(errorStatuses(forServer('201-199'), [198, 199, 200, 201, 202]), [199, 200, 201])
    })

    it('pins the ends of a configured range', () => {
      const validate = forServer('400-402')

      assert.deepStrictEqual(errorStatuses(validate, [399, 400, 402, 403]), [400, 402])
    })

    it('replaces the default rather than adding to it', () => {
      assert.deepStrictEqual(errorStatuses(forServer('404'), [404, 500, 503]), [404])
    })

    it('falls back to the default for an unparseable or non-string value', () => {
      for (const value of ['not-a-range', '600-700', '99', '', 500]) {
        assert.deepStrictEqual(
          errorStatuses(forServer(value), [404, 500]),
          [500],
          `${JSON.stringify(value)} must fall back to 500-599`
        )
      }
    })
  })
})
