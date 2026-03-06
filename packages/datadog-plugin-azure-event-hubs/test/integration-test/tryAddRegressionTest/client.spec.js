'use strict'

const assert = require('assert')
const {
  assertObjectContains,
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let spawnEnv

  withVersions('azure-event-hubs', '@azure/event-hubs', version => {
    useSandbox([`'@azure/event-hubs@${version}'`], false, [
      './packages/datadog-plugin-azure-event-hubs/test/integration-test/tryAddRegressionTest/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      process.env.DD_TRACE_DISABLED_PLUGINS = 'amqplib,amqp10,rhea,net'
      spawnEnv = { DD_TRACE_FLUSH_INTERVAL: '2000', NODE_OPTIONS: '--experimental-global-webcrypto' }
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('tryAdd returns a boolean, not a Promise', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(Array.isArray(payload))
        assertObjectContains(payload, {
          length: 3,
          0: {
            0: {
              name: 'azure.eventhubs.create',
            },
          },
          1: {
            0: {
              name: 'azure.eventhubs.create',
            },
          },
          2: {
            0: {
              name: 'azure.eventhubs.send',
            },
          },
        })
      })

      // This test file will throw an error if tryAdd returns a Promise instead of a boolean
      proc = await spawnPluginIntegrationTestProcAndExpectExit(
        sandboxCwd(), 'server.mjs', agent.port, spawnEnv
      )

      await res
    }).timeout(60000)
  })
})
