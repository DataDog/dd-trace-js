'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('azure-event-hubs', '@azure/event-hubs', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'@azure/event-hubs@${version}'`], false, [
        './packages/datadog-plugin-azure-event-hubs/test/integration-test/*'])
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
        assert.strictEqual(checkSpansForServiceName(payload, 'azure.eventhubs.send'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      await res
    }).timeout(20000)

    it('injects context to the message properties', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        // list of eventData
        assert.propertyVal(payload[1][0].meta, 'messaging.system', 'eventhubs')
        assert.propertyVal(payload[1][0].meta, 'messaging.destination.name', 'eh1')
        assert.propertyVal(payload[1][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[1][0].meta, 'network.destination.name', '127.0.0.1')
        assert.propertyVal(payload[1][0].metrics, 'messaging.batch.message_count', 2)
        // list of AMPQ messages
        assert.propertyVal(payload[2][0].meta, 'messaging.system', 'eventhubs')
        assert.propertyVal(payload[2][0].meta, 'messaging.destination.name', 'eh1')
        assert.propertyVal(payload[2][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[2][0].meta, 'network.destination.name', '127.0.0.1')
        assert.propertyVal(payload[2][0].metrics, 'messaging.batch.message_count', 2)
        // Batch -> EventDataBatchImpl
        assert.propertyVal(payload[3][0].meta, 'messaging.system', 'eventhubs')
        assert.propertyVal(payload[3][0].meta, 'messaging.destination.name', 'eh1')
        assert.propertyVal(payload[3][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[3][0].meta, 'messaging.system', 'eventhubs')
        assert.propertyVal(payload[3][0].meta, 'network.destination.name', '127.0.0.1')
        assert.propertyVal(payload[3][0].metrics, 'messaging.batch.message_count', 4)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      await res
    }).timeout(60000)
  })
})
