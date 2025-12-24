'use strict'

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')
const assert = require('assert')

const spawnEnv = { DD_TRACE_FLUSH_INTERVAL: '2000' }
const nodeOptions = '--experimental-global-webcrypto'

describe('esm', () => {
  let agent
  let proc

  withVersions('azure-event-hubs', '@azure/event-hubs', version => {
    useSandbox([`'@azure/event-hubs@${version}'`], false, [
      './packages/datadog-plugin-azure-event-hubs/test/integration-test/batchSpanContextRegressionTest/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      process.env.DD_TRACE_DISABLED_PLUGINS = 'amqplib,amqp10,rhea,net'
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('tryAdd does not set context in the Azure eventDataBatch._spanContext', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 3)
        // Verify we got the expected spans from the test
        assert.strictEqual(payload[0][0].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[1][0].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[2][0].name, 'azure.eventhubs.send')
      })

      // This test file will throw an error if tryAdd returns a Promise instead of a boolean
      proc = await spawnPluginIntegrationTestProc(
        sandboxCwd(), 'server.mjs', agent.port, undefined, spawnEnv, nodeOptions
      )

      await res
    }).timeout(60000)
  })
})
