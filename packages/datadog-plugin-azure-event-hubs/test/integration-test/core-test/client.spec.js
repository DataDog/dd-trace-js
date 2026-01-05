'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  assertObjectContains,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

const spawnEnv = {
  DD_TRACE_FLUSH_INTERVAL: '2000', NODE_OPTIONS: '--experimental-global-webcrypto'
}

describe('esm', () => {
  let agent
  let proc

  withVersions('azure-event-hubs', '@azure/event-hubs', version => {
    useSandbox([`'@azure/event-hubs@${version}'`], false, [
      './packages/datadog-plugin-azure-event-hubs/test/integration-test/core-test/*'])

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
        assert.strictEqual(checkSpansForServiceName(payload, 'azure.eventhubs.send'), true)
      })

      proc = await spawnPluginIntegrationTestProc(
        sandboxCwd(), 'server.mjs', agent.port, undefined, spawnEnv)
      await res
    }).timeout(20000)

    it('injects context to the message properties', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        // list of EventData
        assert.strictEqual(payload.length, 5)
        assertObjectContains(payload[0][0], {
          name: 'azure.eventhubs.send',
          meta: {
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1:5673'
          },
          metrics: {
            'messaging.batch.message_count': 2
          }
        })
        // list of AMPQ messages
        assertObjectContains(payload[1][0], {
          name: 'azure.eventhubs.send',
          meta: {
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1:5673'
          },
          metrics: {
            'messaging.batch.message_count': 2
          }
        })
        // Batch -> EventDataBatchImpl
        assertObjectContains(payload[2][0], {
          name: 'azure.eventhubs.create',
          meta: {
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1:5673'
          }
        })
        assertObjectContains(payload[3][0], {
          name: 'azure.eventhubs.create',
          meta: {
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'messaging.operation': 'create',
            'network.destination.name': '127.0.0.1:5673'
          }
        })
        assertObjectContains(payload[4][0], {
          name: 'azure.eventhubs.send',
          meta: {
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'messaging.operation': 'send',
            'network.destination.name': '127.0.0.1:5673'
          },
          metrics: {
            'messaging.batch.message_count': 4
          }
        })
        assert.strictEqual(parseLinks(payload[4][0]).length, 2)
      })

      proc = await spawnPluginIntegrationTestProc(
        sandboxCwd(), 'server.mjs', agent.port, undefined, spawnEnv)
      await res
    }).timeout(60000)

    it('does not add span links when they are disabled', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(!('_dd.span_links' in payload[2][0]))
      })
      const envVar = { DD_TRACE_AZURE_EVENTHUBS_BATCH_LINKS_ENABLED: 'false', ...spawnEnv }
      proc = await spawnPluginIntegrationTestProc(
        sandboxCwd(), 'server.mjs', agent.port, undefined, envVar)
      await res
    }).timeout(60000)
  })
})

function parseLinks (span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}
