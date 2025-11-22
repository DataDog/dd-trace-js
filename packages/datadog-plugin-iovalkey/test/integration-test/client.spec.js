'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc

  withVersions('iovalkey', 'iovalkey', version => {
    useSandbox([`'iovalkey@${version}'`], false, [
      './packages/datadog-plugin-iovalkey/test/integration-test/*'])

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
        assert.strictEqual(checkSpansForServiceName(payload, 'valkey.command'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
