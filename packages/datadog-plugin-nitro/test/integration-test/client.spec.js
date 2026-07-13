'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')

/**
 * Issues a GET request and resolves once the response has been fully consumed.
 *
 * @param {string} url - The URL to request.
 * @param {Record<string, string>} [headers] - Optional request headers.
 * @returns {Promise<{ statusCode: number | undefined }>}
 */
function httpGet (url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      res.resume()
      res.once('end', () => resolve({ statusCode: res.statusCode }))
      res.once('error', reject)
    }).once('error', reject)
  })
}

function findNitroSpan (payload) {
  return payload.flat().find(s => s.name === 'nitro.server.request')
}

// h3 v2 is ESM-only. We test by spawning a separate Node process that imports h3
// as ESM and starts an HTTP server. This avoids the ritm/require incompatibility
// with ESM-only packages in the standard test infrastructure.
describe('nitro ESM', () => {
  let agent
  let proc

  // Install h3 into a sandbox; the spawned servers import it as ESM from there.
  useSandbox(["'h3@2.0.1-rc.22'"], false, [
    path.join(__dirname, '*'),
  ])

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  async function spawnServer (serverFile = 'server.mjs') {
    proc = await spawnPluginIntegrationTestProc(sandboxCwd(), serverFile, agent.port)
    return proc
  }

  it('creates a nitro.server.request span when h3 handles a request', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

      const span = findNitroSpan(payload)
      assert.ok(span, `expected a 'nitro.server.request' span; got ${inspect(payload.flat().map(s => s.name))}`)
      assert.strictEqual(span.resource, 'GET /hello')
      assert.strictEqual(span.type, 'web')
      assert.strictEqual(span.meta.component, 'nitro')
      assert.strictEqual(span.meta['span.kind'], 'server')
      assert.strictEqual(span.meta['http.method'], 'GET')
      assert.strictEqual(span.meta['http.route'], '/hello')
      assert.strictEqual(span.meta['http.status_code'], '200')
    })
    await httpGet(`${proc.url}/hello`)
    return assertion
  }).timeout(30000)

  it('captures http.url with the request path', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.meta['http.method'], 'GET')
      assert.ok(span.meta['http.url']?.includes('/hello'),
        `expected http.url to contain '/hello', got ${span.meta['http.url']}`)
    })
    await httpGet(`${proc.url}/hello`)
    return assertion
  }).timeout(30000)

  it('captures the route pattern (not the actual path) for parameterized routes', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.resource, 'GET /users/:id')
      assert.strictEqual(span.meta['http.route'], '/users/:id')
      assert.strictEqual(span.meta['http.status_code'], '200')
    })
    await httpGet(`${proc.url}/users/42`)
    return assertion
  }).timeout(30000)

  it('creates a nitro.server.request span for unmatched requests', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.resource, 'GET')
      assert.strictEqual(span.meta['http.method'], 'GET')
      assert.strictEqual(span.meta['http.route'], undefined)
      assert.strictEqual(span.meta['http.status_code'], '404')
      assert.strictEqual(span.error, 0)
    })
    const res = await httpGet(`${proc.url}/missing`)
    assert.strictEqual(res.statusCode, 404)
    return assertion
  }).timeout(30000)

  it('propagates distributed trace context from incoming headers', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.ok(span.parent_id && span.parent_id.toString() !== '0',
        'expected non-zero parent_id from injected headers')
      assert.notStrictEqual(span.parent_id.toString(), '9876543210')
    })
    await httpGet(`${proc.url}/hello`, {
      'x-datadog-trace-id': '1234567890',
      'x-datadog-parent-id': '9876543210',
      'x-datadog-sampling-priority': '1',
    })
    return assertion
  }).timeout(30000)

  it('generates a span with error tags on the error path', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.error, 1)
      assert.strictEqual(span.meta.component, 'nitro')
      assert.strictEqual(span.meta['error.type'], 'Error')
      assert.strictEqual(span.meta['error.message'], 'nitro test boom')
      assert.strictEqual(span.meta['http.status_code'], '500')
    })
    await httpGet(`${proc.url}/error`)
    return assertion
  }).timeout(30000)

  it('does not use JSON body status fields as the HTTP status code', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.resource, 'GET /status-body')
      assert.strictEqual(span.meta['http.route'], '/status-body')
      assert.strictEqual(span.meta['http.status_code'], '200')
      assert.strictEqual(span.error, 0)
    })
    const res = await httpGet(`${proc.url}/status-body`)
    assert.strictEqual(res.statusCode, 200)
    return assertion
  }).timeout(30000)

  it('marks returned Response objects with failing statuses as errors', async () => {
    await spawnServer()
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.resource, 'GET /response-error')
      assert.strictEqual(span.meta['http.route'], '/response-error')
      assert.strictEqual(span.meta['http.status_code'], '503')
      assert.strictEqual(span.error, 1)
    })
    const res = await httpGet(`${proc.url}/response-error`)
    assert.strictEqual(res.statusCode, 503)
    return assertion
  }).timeout(30000)

  it('applies nitro plugin config before finishing spans', async () => {
    await spawnServer('server-config.mjs')
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = findNitroSpan(payload)
      assert.ok(span, 'expected a nitro.server.request span')
      assert.strictEqual(span.service, 'configured-nitro')
      assert.strictEqual(span.resource, 'GET /response-error')
      assert.strictEqual(span.meta['http.status_code'], '503')
      assert.strictEqual(span.meta['nitro.request_hook'], 'true')
      assert.strictEqual(span.error, 0)
    })
    const res = await httpGet(`${proc.url}/response-error`)
    assert.strictEqual(res.statusCode, 503)
    return assertion
  }).timeout(30000)

  it('produces exactly one span when h3 native tracing is also enabled (no double wrapping)', async () => {
    await spawnServer('server-double.mjs')
    const assertion = agent.assertMessageReceived(({ payload }) => {
      const spans = payload.flat().filter(s => s.name === 'nitro.server.request')
      assert.strictEqual(spans.length, 1,
        `expected exactly one nitro.server.request span, got ${spans.length}`)
      assert.strictEqual(spans[0].resource, 'GET /hello')
      assert.strictEqual(spans[0].meta['http.status_code'], '200')
    })
    await httpGet(`${proc.url}/hello`)
    return assertion
  }).timeout(30000)
})
