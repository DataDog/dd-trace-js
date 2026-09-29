'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const { createSiteUrl, normalizeSite, parseUrl } = require('../../../src/exporters/common/url')

describe('exporters/common/url createSiteUrl', () => {
  it('creates an HTTPS URL from a site and intake', () => {
    assert.strictEqual(
      createSiteUrl('DATADOGHQ.EU', 'debugger-intake').href,
      'https://debugger-intake.datadoghq.eu/'
    )
  })

  it('normalizes outer whitespace and defaults blank sites', () => {
    assert.strictEqual(normalizeSite('  DATADOGHQ.EU  '), 'datadoghq.eu')
    assert.strictEqual(normalizeSite('  '), 'datadoghq.com')
    assert.strictEqual(normalizeSite(undefined), 'datadoghq.com')
  })

  for (const site of [
    'not a host',
    'datadoghq.com@evil.example',
    'datadoghq.com:password@evil.example',
    'datadoghq.com:443',
    'datadoghq.com/path',
    'datadoghq.com?query',
    'datadoghq.com#fragment',
    'datadoghq\\.com',
    'datadoghq..com',
    '-datadoghq.com',
    'datadoghq-.com',
    'dátadoghq.com',
  ]) {
    it(`rejects a site with URL components: ${site}`, () => {
      assert.strictEqual(createSiteUrl(site, 'debugger-intake'), undefined)
      assert.strictEqual(createSiteUrl(site), undefined)
    })
  }

  it('rejects a valid site suffix when the composed intake hostname is too long', () => {
    const label = 'a'.repeat(63)
    const site = `${label}.${label}.${label}.${'a'.repeat(49)}`

    assert.strictEqual(createSiteUrl(site, 'event-platform-intake'), undefined)
  })
})

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
