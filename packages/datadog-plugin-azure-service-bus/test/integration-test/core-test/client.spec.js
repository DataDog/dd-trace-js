'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  assertObjectContains,
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
      './packages/datadog-plugin-azure-service-bus/test/integration-test/core-test/*'])

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
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, spawnEnv)

      await res
    }).timeout(20000)

    it('injects context to the message properties', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(payload.length, 23)
        // queue message
        assertObjectContains(payload[0][0], {
          name: 'azure.servicebus.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1'
          }
        })
        // queue array of messages
        assertObjectContains(payload[1][0], {
          name: 'azure.servicebus.create',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[2][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[3][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.operation': 'send',
            'messaging.destination.name': 'queue.1'
          }
        })
        // queue amqp messages
        assert.strictEqual(payload[1][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[4][0], {
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[5][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[6][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.operation': 'send',
            'messaging.destination.name': 'queue.1'
          }
        })

        // topic message
        assertObjectContains(payload[7][0], {
          name: 'azure.servicebus.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'topic.1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1'
          }
        })
        // topic array of messages
        assertObjectContains(payload[8][0], {
          name: 'azure.servicebus.create',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[9][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[10][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.operation': 'send',
            'messaging.destination.name': 'topic.1'
          }
        })

        // topic amqp messages
        assertObjectContains(payload[11][0], {
          name: 'azure.servicebus.create',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[12][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[13][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.operation': 'send',
            'messaging.destination.name': 'topic.1'
          }
        })
        // scheduled message
        assertObjectContains(payload[14][0], {
          name: 'azure.servicebus.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1'
          }
        })
        // scheduled array of messages
        assertObjectContains(payload[15][0], {
          name: 'azure.servicebus.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1'
          }
        })
        // scheduled amqp messages
        assertObjectContains(payload[16][0], {
          name: 'azure.servicebus.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1'
          }
        })

        // queue batch
        assertObjectContains(payload[17][0], {
          name: 'azure.servicebus.create',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[18][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[19][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.destination.name': 'queue.1'
          },
          metrics: {
            'messaging.batch.message_count': 2
          }
        })
        assert.strictEqual(parseLinks(payload[19][0]).length, 2)

        // topic batch
        assertObjectContains(payload[20][0], {
          name: 'azure.servicebus.create',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'servicebus',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1'
          }
        })
        assert.strictEqual(payload[21][0].name, 'azure.servicebus.create')
        assertObjectContains(payload[22][0], {
          name: 'azure.servicebus.send',
          meta: {
            'messaging.destination.name': 'topic.1'
          },
          metrics: {
            'messaging.batch.message_count': 2
          }
        })
        assert.strictEqual(parseLinks(payload[22][0]).length, 2)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, spawnEnv)

      await res
    }).timeout(60000)
  })
})

function parseLinks (span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}
