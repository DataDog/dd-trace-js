'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const version = require('../../../../version.js')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

// tedious does not support node 20
const describe = version.NODE_MAJOR >= 20
  ? global.describe.skip
  : global.describe

describe('esm', () => {
  let agent
  let proc

  // test against later versions because server.mjs uses newer package syntax
  withVersions('tedious', 'tedious', '>=16.0.0', version => {
    useSandbox([`'tedious@${version}'`], false, [
      './packages/datadog-plugin-tedious/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers['host'], `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        assert.strictEqual(checkSpansForServiceName(payload, 'tedious.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
