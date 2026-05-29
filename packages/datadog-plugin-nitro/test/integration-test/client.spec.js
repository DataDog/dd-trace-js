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
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('nitro', 'h3', version => {
    useSandbox([`'h3@${version}'`], false, [
      path.join(__dirname, '*'),
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('is instrumented when h3 is imported as ESM', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

        // Locate the nitro server span and verify the full set of tags an HTTP server
        // integration must capture (method, route, status, component). Without these
        // assertions a regression that broke any tag would still pass.
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
    }).timeout(20000)
  })
})
