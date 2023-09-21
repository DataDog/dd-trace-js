'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('sharedb', 'sharedb', '>=3', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'sharedb@${version}'`], false, [
        `./packages/datadog-plugin-sharedb/test/integration-test/*`])
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

    context('sharedb', () => {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'sharedb.request'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

        await res
      }).timeout(20000)
    })
  })
})
