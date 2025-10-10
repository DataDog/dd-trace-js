'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('anthropic', ['@anthropic-ai/sdk'], version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([
        `@anthropic-ai/sdk@${version}`,
      ], false, [
        './packages/datadog-plugin-anthropic/test/integration-test/*'
      ])
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'anthropic.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, {
        NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        ANTHROPIC_API_KEY: '<not-a-real-key>'
      })

      await res
    }).timeout(20000)
  })
})
