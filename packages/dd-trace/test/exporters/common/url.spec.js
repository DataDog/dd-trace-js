'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const { parseUrl } = require('../../../src/exporters/common/url')

describe('exporters/common/url parseUrl', () => {
  describe('unix domain sockets', () => {
    it('keeps the socket path for a string URL', () => {
      const url = parseUrl('unix:///var/run/datadog/apm.socket')

      assert.strictEqual(url.protocol, 'unix:')
      assert.strictEqual(url.pathname, '/var/run/datadog/apm.socket')
    })

    it('keeps the socket path for a URL object', () => {
      const url = parseUrl(new URL('unix:///var/run/datadog/apm.socket'))

      assert.strictEqual(url.protocol, 'unix:')
      assert.strictEqual(url.pathname, '/var/run/datadog/apm.socket')
    })
  })

  // The `.` authority of a `unix://./pipe/<name>` URL is parsed out of the path,
  // so it must be folded back into `//./pipe/<name>`. Both branches matter: the
  // string form is what tests/CLIs pass, the object form is what config hands
  // every exporter.
  describe('windows named pipes', () => {
    it('folds the authority back for a string URL', () => {
      const url = parseUrl('unix://./pipe/datadog')

      assert.strictEqual(url.protocol, 'unix:')
      assert.strictEqual(url.pathname, '//./pipe/datadog')
    })

    it('folds the authority back for a URL object', () => {
      const url = parseUrl(new URL('unix://./pipe/datadog'))

      assert.strictEqual(url.protocol, 'unix:')
      assert.strictEqual(url.pathname, '//./pipe/datadog')
    })

    it('keeps the backslash form untouched', () => {
      const url = parseUrl(new URL('unix:\\\\.\\pipe\\datadog'))

      assert.strictEqual(url.protocol, 'unix:')
      assert.strictEqual(url.pathname, '\\\\.\\pipe\\datadog')
    })
  })

  describe('http(s) urls', () => {
    it('maps protocol, hostname and port for a string URL', () => {
      const url = parseUrl('https://127.0.0.1:8126/path')

      assert.strictEqual(url.protocol, 'https:')
      assert.strictEqual(url.hostname, '127.0.0.1')
      assert.strictEqual(String(url.port), '8126')
    })

    it('maps protocol, hostname and port for a URL object', () => {
      const url = parseUrl(new URL('http://localhost:8126'))

      assert.strictEqual(url.protocol, 'http:')
      assert.strictEqual(url.hostname, 'localhost')
      assert.strictEqual(String(url.port), '8126')
    })
  })
})
