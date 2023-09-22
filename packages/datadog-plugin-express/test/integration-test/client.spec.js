'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('express', 'express', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'express@${version}'`], false,
        [`./packages/datadog-plugin-express/test/integration-test/*`])
    })

    after(async function () {
      this.timeout(50000)
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
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 4)
        assert.propertyVal(payload[0][0], 'name', 'express.request')
        assert.propertyVal(payload[0][1], 'name', 'express.middleware')
      })
    }).timeout(50000)
  })
})
