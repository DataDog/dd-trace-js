'use strict'

const assert = require('node:assert/strict')

const { createApiRequestRoute } = require('../../../src/ci-visibility/requests/route')

describe('createApiRequestRoute', () => {
  const url = new URL('https://api.datadoghq.com')
  const path = '/api/v2/test'

  it('creates an authenticated direct API route', () => {
    const route = createApiRequestRoute(
      { DD_API_KEY: 'api-key' },
      { url, path, isEvpProxy: false, evpProxyPrefix: '' }
    )

    assert.deepStrictEqual(route, {
      url,
      path,
      headers: { 'dd-api-key': 'api-key' },
    })
  })

  it('does not create a direct API route without an API key', () => {
    const route = createApiRequestRoute({}, { url, path, isEvpProxy: false, evpProxyPrefix: '' })

    assert.strictEqual(route, undefined)
  })

  it('creates a keyless EVP proxy route', () => {
    const route = createApiRequestRoute(
      {},
      { url, path, isEvpProxy: true, evpProxyPrefix: '/evp_proxy/v4' }
    )

    assert.deepStrictEqual(route, {
      url,
      path: '/evp_proxy/v4/api/v2/test',
      headers: { 'X-Datadog-EVP-Subdomain': 'api' },
    })
  })
})
