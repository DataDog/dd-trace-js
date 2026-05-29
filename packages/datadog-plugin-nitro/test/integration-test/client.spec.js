'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')

// h3 v2 is ESM-only. We test by spawning a separate Node process (server.mjs)
// that imports h3 as ESM and starts an HTTP server. This avoids the ritm/require
// incompatibility with ESM-only packages in the standard test infrastructure.
describe('nitro ESM', () => {
  let agent
  let proc

  // Install h3 into a sandbox; server.mjs imports it as ESM from there.
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

  it('creates a nitro.server.request span when h3 handles a request', async () => {
    proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

    return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
      assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
      assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

      const spans = payload.flat()
      const span = spans.find(s => s.name === 'nitro.server.request')
      assert.ok(span, `expected a 'nitro.server.request' span; got ${inspect(spans.map(s => s.name))}`)
      assert.strictEqual(span.resource, 'GET /hello')
      assert.strictEqual(span.type, 'web')
      assert.strictEqual(span.meta.component, 'nitro')
      assert.strictEqual(span.meta['span.kind'], 'server')
      assert.strictEqual(span.meta['http.method'], 'GET')
      assert.strictEqual(span.meta['http.route'], '/hello')
      assert.strictEqual(span.meta['http.status_code'], '200')
    })
  }).timeout(30000)
})
