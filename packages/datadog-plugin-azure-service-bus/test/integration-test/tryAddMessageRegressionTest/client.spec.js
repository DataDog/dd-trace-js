'use strict'

const assert = require('assert')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

const spawnEnv = { DD_TRACE_FLUSH_INTERVAL: '2000' }

describe('esm', () => {
  let agent
  let proc

  withVersions('azure-service-bus', '@azure/service-bus', version => {
    useSandbox([`'@azure/service-bus@${version}'`], false, [
      './packages/datadog-plugin-azure-service-bus/test/integration-test/tryAddMessageRegressionTest/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      process.env.DD_TRACE_DISABLED_PLUGINS = 'amqplib,amqp10,rhea,net'
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('tryAddMessage returns a boolean, not a Promise', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 3)
        // Verify we got the expected spans from the test
        assert.strictEqual(payload[0][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[1][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[2][0].name, 'azure.servicebus.send')
      })

      // This test file will throw an error if tryAddMessage returns a Promise instead of a boolean
      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, spawnEnv)

      await res
    }).timeout(60000)
  })
})
