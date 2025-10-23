'use strict'

const {
  FakeAgent,
  linkedSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const version = require('../../../../version.js')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

// tedious does not support node 20
const describe = version.NODE_MAJOR >= 20
  ? global.describe.skip
  : global.describe

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('tedious', 'tedious', '>=16.0.0', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await linkedSandbox([`'tedious@${version}'`], false, [
        './packages/datadog-plugin-tedious/test/integration-test/*'])
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
        assert.strictEqual(checkSpansForServiceName(payload, 'tedious.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
