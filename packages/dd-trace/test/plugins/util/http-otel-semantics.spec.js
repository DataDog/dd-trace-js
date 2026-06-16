'use strict'

const assert = require('node:assert/strict')

const {
  decomposeServerUrl,
  HTTP_REQUEST_METHOD,
  HTTP_RESPONSE_STATUS_CODE,
  URL_FULL,
  URL_PATH,
  SERVER_ADDRESS,
} = require('../../../src/plugins/util/http-otel-semantics')

describe('http-otel-semantics', () => {
  describe('attribute names', () => {
    it('uses the OpenTelemetry HTTP semantic-convention names', () => {
      assert.strictEqual(HTTP_REQUEST_METHOD, 'http.request.method')
      assert.strictEqual(HTTP_RESPONSE_STATUS_CODE, 'http.response.status_code')
      assert.strictEqual(URL_FULL, 'url.full')
      assert.strictEqual(URL_PATH, 'url.path')
      assert.strictEqual(SERVER_ADDRESS, 'server.address')
    })
  })

  describe('decomposeServerUrl', () => {
    it('splits scheme, address, port, path, and query', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('http://localhost:8200/a/b?demo=1', 'http://localhost:8200/a/b?demo=1'),
        { scheme: 'http', address: 'localhost', port: 8200, path: '/a/b', query: 'demo=1' }
      )
    })

    it('omits the port when it is the scheme default', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('https://example.com/p', 'https://example.com/p'),
        { scheme: 'https', address: 'example.com', port: undefined, path: '/p', query: undefined }
      )
    })

    it('omits the query when there is none', () => {
      const parts = decomposeServerUrl('http://h:8080/', 'http://h:8080/')
      assert.strictEqual(parts.path, '/')
      assert.strictEqual(parts.port, 8080)
      assert.strictEqual(parts.query, undefined)
    })

    it('takes the query from the obfuscated URL so redaction is preserved', () => {
      const parts = decomposeServerUrl('http://h/x?secret=1', 'http://h/x?<redacted>')
      assert.strictEqual(parts.query, '<redacted>')
    })

    it('falls back to the root path for a malformed URL', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('not-a-valid-url', 'not-a-valid-url'),
        { scheme: undefined, address: undefined, port: undefined, path: '/', query: undefined }
      )
    })
  })
})
