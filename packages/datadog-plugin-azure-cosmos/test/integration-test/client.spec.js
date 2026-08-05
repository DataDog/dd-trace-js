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
  let spawnEnv

  withVersions('azure-cosmos', '@azure/cosmos', (version) => {
    useSandbox([`'@azure/cosmos@${version}'`], false, [
      './packages/datadog-plugin-azure-cosmos/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'CosmosClient',
      packageName: '@azure/cosmos',
      defaultExport: false,
      namedExports: ['CosmosClient'],
      namedExportBinding: 'direct',
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      spawnEnv = { NODE_OPTIONS: '--experimental-global-webcrypto' }
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `expected payload to be an array, got ${typeof payload}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'cosmosdb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          spawnEnv
        )

        await res
      }).timeout(20000)
    }
  })
})
