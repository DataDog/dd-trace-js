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
const range = NODE_MAJOR < 16 ? '<5' : '>=4'

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('mongoose', ['mongoose'], range, version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'mongoose@${version}'`], false, [
        `./packages/datadog-plugin-mongoose/test/integration-test/*`])
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
        assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
