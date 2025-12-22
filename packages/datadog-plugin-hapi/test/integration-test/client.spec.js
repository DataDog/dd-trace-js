'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

describe('esm', () => {
  let agent
  let proc

  withVersions('hapi', '@hapi/hapi', version => {
    useSandbox([`'@hapi/hapi@${version}'`], false, [
      './packages/datadog-plugin-hapi/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
        assert.ok(Array.isArray(payload))
        assert.strictEqual(checkSpansForServiceName(payload, 'hapi.request'), true)
      })
    }).timeout(20000)
  })
})
