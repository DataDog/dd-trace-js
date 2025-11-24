'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const describe = globalThis.fetch ? globalThis.describe : globalThis.describe.skip

describe('esm', () => {
  let agent
  let proc

  useSandbox([], false, [
    './packages/datadog-plugin-fetch/test/integration-test/*'])

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('fetch', () => {
    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        const isFetch = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'fetch'))
        assert.strictEqual(isFetch, true)
      })

      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      await res
    }).timeout(50000)
  })
})
