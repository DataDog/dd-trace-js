'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

// newer packages are not supported on older node versions
const range = NODE_MAJOR < 16 ? '<3' : '>=4.4.0'

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('cassandra-driver', 'cassandra-driver', range, version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'cassandra-driver@${version}'`], false, [
        `./packages/datadog-plugin-cassandra-driver/test/integration-test/*`])
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
        assert.strictEqual(checkSpansForServiceName(payload, 'cassandra.query'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
