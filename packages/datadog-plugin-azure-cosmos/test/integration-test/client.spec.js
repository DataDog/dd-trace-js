'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  useSandbox,
  sandboxCwd,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('azure-cosmos', '@azure/cosmos', (version) => {
    useSandbox([`'@azure/cosmos@${version}'`], false, [
      './packages/datadog-plugin-azure-cosmos/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'CosmosClient', undefined, '@azure/cosmos', true)
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of ['star', 'destructure']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'cosmosdb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port
        )

        await res
      }).timeout(20000)
    }
  })
})
