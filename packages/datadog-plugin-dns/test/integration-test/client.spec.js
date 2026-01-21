'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
describe('esm', () => {
  let agent
  let proc
  let variants

  useSandbox([], false, [
    './packages/datadog-plugin-dns/test/integration-test/*'])

  before(async function () {
    variants = varySandbox('server.mjs', 'dns', 'lookup')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('dns', () => {
    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'dns.lookup'), true)
          assert.strictEqual(payload[0][0].resource, 'fakedomain.faketld')
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
