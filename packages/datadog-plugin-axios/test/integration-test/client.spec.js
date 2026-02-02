'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
} = require('../../../../integration-tests/helpers')
describe('esm', () => {
  let agent
  let proc
  let variants

  useSandbox(['axios'], false, [
    './packages/datadog-plugin-axios/test/integration-test/*'])

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  before(async function () {
    variants = varySandbox('server.mjs', 'axios')
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('axios', () => {
    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'http.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
