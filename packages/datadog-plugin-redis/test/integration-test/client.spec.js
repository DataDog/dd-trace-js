'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

// Error: Command failed: yarn add file:/tmp/701a143ad8465e61/dd-trace.tgz 'redis@^4'
// error @redis/client@1.5.10: The engine "node" is incompatible with this module.
// Expected version ">=18". Got "16.20.2" error Found incompatible module.
// const describe = NODE_MAJOR < 18 ? globalThis.describe.skip : globalThis.describe

describe('esm', () => {
  let agent
  let proc
  let sandbox
  // test against later versions because server.mjs uses newer package syntax
  withVersions('redis', 'redis', '>=4', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'redis@${version}'`], false, [
        `./packages/datadog-plugin-redis/test/integration-test/*`])
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'redis.command'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
