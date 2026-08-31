'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  EVP_PROXY_PATH_V2,
  EVP_PROXY_PATH_V4,
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_EVENT_PLATFORM_SUBDOMAIN,
} = require('../../src/evp_proxy/constants')

describe('EVP proxy constants', () => {
  it('exposes protocol-wide paths and header name', () => {
    assert.strictEqual(EVP_PROXY_PATH_V2, '/evp_proxy/v2')
    assert.strictEqual(EVP_PROXY_PATH_V4, '/evp_proxy/v4')
    assert.strictEqual(EVP_SUBDOMAIN_HEADER_NAME, 'X-Datadog-EVP-Subdomain')
    assert.strictEqual(EVP_EVENT_PLATFORM_SUBDOMAIN, 'event-platform-intake')
  })
})
