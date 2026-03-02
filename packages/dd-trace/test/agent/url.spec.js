'use strict'

const assert = require('node:assert/strict')
const { URL } = require('url')

const { describe, it } = require('mocha')

require('../setup/core')
const { getAgentUrl } = require('../../src/agent/url')
const defaults = require('../../src/config/defaults')

describe('agent/url', () => {
  describe('getAgentUrl', () => {
    it('should return the url from config when provided', () => {
      const url = new URL('http://custom-host:9999')
      const config = { url }

      const result = getAgentUrl(config)

      assert.strictEqual(result, url)
    })

    it('should construct URL from hostname and port', () => {
      const config = {
        hostname: 'custom-host',
        port: '9999',
      }

      const result = getAgentUrl(config)

      assert.ok(result instanceof URL)
      assert.strictEqual(result.hostname, 'custom-host')
      assert.strictEqual(result.port, '9999')
      assert.strictEqual(result.protocol, 'http:')
    })

    it('should use default hostname when not provided', () => {
      const config = {
        port: '9999',
      }

      const result = getAgentUrl(config)

      assert.strictEqual(result.hostname, defaults.hostname)
      assert.strictEqual(result.port, '9999')
    })

    it('should use default port when not provided in config', () => {
      const config = {
        hostname: 'custom-host',
      }

      const result = getAgentUrl(config)

      assert.strictEqual(result.hostname, 'custom-host')
      assert.strictEqual(result.port, defaults.port)
      assert.strictEqual(result.protocol, 'http:')
    })

    it('should use defaults when hostname and port not provided', () => {
      const config = {}

      const result = getAgentUrl(config)

      assert.strictEqual(result.hostname, defaults.hostname)
      assert.strictEqual(result.port, defaults.port)
      assert.strictEqual(result.protocol, 'http:')
    })

    it('should prioritize url over hostname and port', () => {
      const url = new URL('http://url-host:1111')
      const config = {
        url,
        hostname: 'ignored-host',
        port: '2222',
      }

      const result = getAgentUrl(config)

      assert.strictEqual(result, url)
      assert.strictEqual(result.hostname, 'url-host')
      assert.strictEqual(result.port, '1111')
    })

    it('should support IPv6 hostnames', () => {
      const config = {
        hostname: '::1',
        port: '8126',
      }

      const result = getAgentUrl(config)

      // IPv6 addresses get wrapped in brackets by URL constructor
      assert.strictEqual(result.hostname, '[::1]')
      assert.strictEqual(result.port, '8126')
      assert.ok(result.href.includes('[::1]:8126'))
    })
  })
})
