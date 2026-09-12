'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('EVP proxy discovery', () => {
  const url = new URL('http://localhost:8126')
  const options = {
    supportedPaths: ['/evp_proxy/v4', '/evp_proxy/v2'],
    requiredHeaders: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
  }

  let discoverEVPProxy
  let fetchAgentInfo
  let log
  let selectEVPProxyPath

  beforeEach(() => {
    fetchAgentInfo = sinon.stub()
    log = { debug: sinon.stub() }

    const discovery = proxyquire('../../src/evp_proxy/discovery', {
      '../agent/info': { fetchAgentInfo },
      '../log': log,
    })

    discoverEVPProxy = discovery.discoverEVPProxy
    selectEVPProxyPath = discovery.selectEVPProxyPath
  })

  describe('selectEVPProxyPath', () => {
    it('uses caller preference order and normalizes trailing slashes', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2/', '/evp_proxy/v4/'],
        evp_proxy_allowed_headers: ['dd-evp-origin', 'dd-evp-origin-version'],
      }, options)

      assert.strictEqual(path, '/evp_proxy/v4')
      sinon.assert.notCalled(fetchAgentInfo)
    })

    it('rejects a missing allowed-header field when forwarding is required', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2'],
      }, options)

      assert.strictEqual(path, undefined)
    })

    it('selects a path without applying optional header requirements', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2/'],
        evp_proxy_allowed_headers: ['Content-Type'],
      }, {
        supportedPaths: ['/evp_proxy/v2'],
      })

      assert.strictEqual(path, '/evp_proxy/v2')
    })

    it('rejects a malformed allowed-header field', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2'],
        evp_proxy_allowed_headers: 'DD-EVP-ORIGIN',
      }, options)

      assert.strictEqual(path, undefined)
    })

    it('rejects a missing required header', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2'],
        evp_proxy_allowed_headers: ['DD-EVP-ORIGIN'],
      }, options)

      assert.strictEqual(path, undefined)
    })

    it('rejects malformed endpoint data', () => {
      assert.strictEqual(selectEVPProxyPath({ endpoints: null }, options), undefined)
    })

    it('matches all required forwarded headers case-insensitively with whitespace', () => {
      const path = selectEVPProxyPath({
        endpoints: ['/evp_proxy/v2'],
        evp_proxy_allowed_headers: [' dd-evp-origin ', 'Dd-EvP-OrIgIn-VeRsIoN'],
      }, options)

      assert.strictEqual(path, '/evp_proxy/v2')
    })
  })

  describe('discoverEVPProxy', () => {
    it('fetches information only when discovery is called', (done) => {
      fetchAgentInfo.yields(null, {
        endpoints: ['/evp_proxy/v2'],
        evp_proxy_allowed_headers: ['dd-evp-origin', 'dd-evp-origin-version'],
      })

      sinon.assert.notCalled(fetchAgentInfo)

      discoverEVPProxy(url, options, (error, route) => {
        assert.ifError(error)
        assert.deepStrictEqual(route, {
          url,
          basePath: '/evp_proxy/v2',
        })
        sinon.assert.calledOnceWithExactly(fetchAgentInfo, url, sinon.match.func, {
          path: '/info',
          retry: false,
        })
        sinon.assert.calledOnceWithExactly(
          log.debug,
          'EVP proxy route %s discovered through the configured local receiver',
          '/evp_proxy/v2'
        )
        done()
      })
    })

    it('returns no route when the Agent is incompatible', (done) => {
      fetchAgentInfo.yields(null, { endpoints: ['/info'] })

      discoverEVPProxy(url, options, (error, route) => {
        assert.ifError(error)
        assert.strictEqual(route, undefined)
        sinon.assert.notCalled(log.debug)
        done()
      })
    })

    it('returns information request errors', (done) => {
      const expectedError = new Error('Agent unavailable')
      fetchAgentInfo.yields(expectedError)

      discoverEVPProxy(url, options, (error, route) => {
        assert.strictEqual(error, expectedError)
        assert.strictEqual(route, undefined)
        sinon.assert.notCalled(log.debug)
        done()
      })
    })

    it('preserves a configured HTTP path prefix for discovery and event routing', (done) => {
      const prefixedUrl = new URL('http://localhost:8126/agent-prefix/')
      fetchAgentInfo.yields(null, {
        endpoints: ['/evp_proxy/v4'],
        evp_proxy_allowed_headers: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
      })

      discoverEVPProxy(prefixedUrl, options, (error, route) => {
        assert.ifError(error)
        assert.deepStrictEqual(route, {
          url: prefixedUrl,
          basePath: '/agent-prefix/evp_proxy/v4',
        })
        sinon.assert.calledOnceWithExactly(fetchAgentInfo, prefixedUrl, sinon.match.func, {
          path: '/agent-prefix/info',
          retry: false,
        })
        done()
      })
    })
  })
})
