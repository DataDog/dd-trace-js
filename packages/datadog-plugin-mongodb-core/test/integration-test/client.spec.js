'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb', '>=4', version => {
    before(async function () {
      this.timeout(30000)
      sandbox = await createSandbox([`'mongodb@${version}'`], false, [
        './packages/datadog-plugin-mongodb-core/test/integration-test/*'])
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
        './packages/datadog-plugin-mongodb-core/test/integration-test/*'])
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
