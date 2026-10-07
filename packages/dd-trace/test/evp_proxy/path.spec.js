'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

describe('EVP proxy path', () => {
  it('joins a known proxy path without discovery', () => {
    const { joinEVPProxyPath } = require('../../src/evp_proxy/path')

    assert.strictEqual(
      joinEVPProxyPath('/evp_proxy/v2/', '/api/v2/exposures'),
      '/evp_proxy/v2/api/v2/exposures'
    )
  })

  it('preserves one separator for an empty base path', () => {
    const { joinEVPProxyPath } = require('../../src/evp_proxy/path')

    assert.strictEqual(joinEVPProxyPath('', '/api/v2/exposures'), '/api/v2/exposures')
  })

  it('joins a configured path prefix, proxy route, and product endpoint', () => {
    const { joinEVPProxyPath } = require('../../src/evp_proxy/path')

    assert.strictEqual(
      joinEVPProxyPath('/agent-prefix/', '/evp_proxy/v4/', '/api/v2/exposures'),
      '/agent-prefix/evp_proxy/v4/api/v2/exposures'
    )
  })

  it('does not treat a Unix socket pathname as an HTTP path prefix', () => {
    const { joinAgentURLPath } = require('../../src/evp_proxy/path')

    assert.strictEqual(
      joinAgentURLPath(new URL('unix:///var/run/datadog/apm.socket'), '/evp_proxy/v2'),
      '/evp_proxy/v2'
    )
  })
})
