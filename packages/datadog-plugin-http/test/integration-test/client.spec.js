'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
describe('esm', () => {
  let agent
  let proc

  useSandbox([], false, [
    './packages/datadog-plugin-http/test/integration-test/*'])

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('http', () => {
    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 1)
        assert.ok(Array.isArray(payload[0]))
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'web.request')
      })
    }).timeout(20000)
  })
})
