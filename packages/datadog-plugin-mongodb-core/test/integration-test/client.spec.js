'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

// Error: Command failed: yarn add file:/tmp/1236761b054ee8e5/dd-trace.tgz mongodb mongodb-core
// error bson@6.0.0: The engine "node" is incompatible with this module. Expected version ">=16.20.1". Got "14.21.3"
// error Found incompatible module.
const describe = NODE_MAJOR < 16 ? globalThis.describe.skip : globalThis.describe

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb', '>=4', version => {
    before(async function () {
      this.timeout(30000)
      sandbox = await createSandbox([`'mongodb@${version}'`], false, [
        `./packages/datadog-plugin-mongodb-core/test/integration-test/*`])
    })

    after(async function () {
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
        assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(30000)
  })

  // test against later versions because server2.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb-core', '>=3', version => {
    before(async function () {
      this.timeout(30000)
      sandbox = await createSandbox([`'mongodb-core@${version}'`], false, [
        `./packages/datadog-plugin-mongodb-core/test/integration-test/*`])
    })

    after(async function () {
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
        assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server2.mjs', agent.port)

      await res
    }).timeout(30000)
  })
})
