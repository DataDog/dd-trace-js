'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('azure-service-bus', '@azure/service-bus', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await createSandbox([`'@azure/service-bus@${version}'`], false, [
        './packages/datadog-plugin-azure-service-bus/test/integration-test/*'])
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      process.env.DD_TRACE_DISABLED_PLUGINS = 'amqplib,amqp10,rhea,net'
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)

    it('injects context to the message properties', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(payload.length, 23)
        // queue message
        assert.strictEqual(payload[0][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[0][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[0][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[0][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[0][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[0][0].meta, 'network.destination.name', '127.0.0.1')
        // queue array of messages
        assert.strictEqual(payload[1][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[1][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[1][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[1][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[1][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[1][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[2][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[3][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[3][0].meta, 'messaging.operation', 'send')
        // queue amqp messages
        assert.strictEqual(payload[1][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[4][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[4][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[4][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[4][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[4][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[5][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[6][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[6][0].meta, 'messaging.operation', 'send')

        // topic message
        assert.strictEqual(payload[7][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[7][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[7][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[7][0].meta, 'messaging.destination.name', 'topic.1')
        assert.propertyVal(payload[7][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[7][0].meta, 'network.destination.name', '127.0.0.1')
        // topic array of messages
        assert.strictEqual(payload[8][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[8][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[8][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[8][0].meta, 'messaging.destination.name', 'topic.1')
        assert.propertyVal(payload[8][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[8][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[9][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[10][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[10][0].meta, 'messaging.operation', 'send')
        // topic amqp messages
        assert.strictEqual(payload[11][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[11][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[11][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[11][0].meta, 'messaging.destination.name', 'topic.1')
        assert.propertyVal(payload[11][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[11][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[12][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[13][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[13][0].meta, 'messaging.operation', 'send')

        // scheduled message
        assert.strictEqual(payload[14][0].name, 'azure.servicebus.send')
        assert.strictEqual(payload[14][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[14][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[14][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[14][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[14][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[14][0].meta, 'network.destination.name', '127.0.0.1')
        // scheduled array of messages
        assert.strictEqual(payload[15][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[15][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[15][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[15][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[15][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[15][0].meta, 'network.destination.name', '127.0.0.1')
        // scheduled amqp messages
        assert.strictEqual(payload[16][0].name, 'azure.servicebus.send')
        assert.propertyVal(payload[16][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[16][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[16][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[16][0].meta, 'messaging.operation', 'send')
        assert.propertyVal(payload[16][0].meta, 'network.destination.name', '127.0.0.1')

        // queue batch
        assert.strictEqual(payload[17][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[17][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[17][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[17][0].meta, 'messaging.destination.name', 'queue.1')
        assert.propertyVal(payload[17][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[17][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[18][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[19][0].name, 'azure.servicebus.send')
        assert.strictEqual(payload[19][0].metrics['messaging.batch.message_count'], 2)

        // topic batch
        assert.strictEqual(payload[20][0].name, 'azure.servicebus.create')
        assert.propertyVal(payload[20][0].meta, 'span.kind', 'producer')
        assert.propertyVal(payload[20][0].meta, 'messaging.system', 'servicebus')
        assert.propertyVal(payload[20][0].meta, 'messaging.destination.name', 'topic.1')
        assert.propertyVal(payload[20][0].meta, 'messaging.operation', 'create')
        assert.propertyVal(payload[20][0].meta, 'network.destination.name', '127.0.0.1')
        assert.strictEqual(payload[21][0].name, 'azure.servicebus.create')
        assert.strictEqual(payload[22][0].name, 'azure.servicebus.send')
        assert.strictEqual(payload[22][0].metrics['messaging.batch.message_count'], 2)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(60000)
  })
})
