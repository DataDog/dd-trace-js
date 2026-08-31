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
})
