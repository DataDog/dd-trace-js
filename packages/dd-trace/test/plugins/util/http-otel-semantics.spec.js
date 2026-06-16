'use strict'

const assert = require('node:assert/strict')

const { decomposeServerUrl } = require('../../../src/plugins/util/http-otel-semantics')

describe('http-otel-semantics', () => {
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

    it('keeps an explicit non-default port and omits an absent query', () => {
      const parts = decomposeServerUrl('http://h:8080/', 'http://h:8080/')
      assert.strictEqual(parts.path, '/')
      assert.strictEqual(parts.port, 8080)
      assert.strictEqual(parts.query, undefined)
    })

    it('takes the query from the obfuscated URL so redaction is preserved', () => {
      const parts = decomposeServerUrl('http://h/x?secret=1', 'http://h/x?<redacted>')
      assert.strictEqual(parts.query, '<redacted>')
    })

    it('strips brackets from an IPv6 server.address', () => {
      const parts = decomposeServerUrl('http://[::1]:8080/p', 'http://[::1]:8080/p')
      assert.strictEqual(parts.address, '::1')
      assert.strictEqual(parts.port, 8080)
    })

    it('omits server.address when the Host header is absent', () => {
      // extractURL builds `http://undefined/...` when req.headers.host is missing.
      const parts = decomposeServerUrl('http://undefined/p', 'http://undefined/p')
      assert.strictEqual(parts.address, undefined)
      assert.strictEqual(parts.path, '/p')
    })

    it('falls back to the root path for a malformed URL while still reading its query', () => {
      assert.deepStrictEqual(
        decomposeServerUrl('not-a-valid-url?x=1', 'not-a-valid-url?x=1'),
        { scheme: undefined, address: undefined, port: undefined, path: '/', query: 'x=1' }
      )
    })
  })
})
