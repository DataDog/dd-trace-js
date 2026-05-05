'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const {
  FakeAgent,
  assertObjectContains,
  curl,
  hookFile,
  sandboxCwd,
  useSandbox,
  stopProc,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

const azureInvokeGroup = (resource) => (group) =>
  group.some(s => s.name === 'azure.functions.invoke' && s.resource === resource)

const azureCreateGroup = (group) =>
  group.some(s => s.name === 'azure.functions.create')

describe('esm', () => {
  withVersions('azure-functions', '@azure/functions', version => {
    useSandbox([
      `@azure/functions@${version}`,
      'azure-functions-core-tools@4',
      '@azure/service-bus@7.9.5',
    ],
    false,
    ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
      './packages/datadog-plugin-azure-functions/test/integration-test/servicebus-test/*'])

    describe('default configuration', () => {
      let agent
      let proc

      before(async function () {
        this.timeout(60000)
        agent = await new FakeAgent().start()
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, {
          PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
        })
      })

      after(async () => {
        await stopProc(proc, { signal: 'SIGINT' })
        await agent.stop()
      })

      it('propagates a single message through a queue with cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-message-1'),
          predicate: azureInvokeGroup('ServiceBus queueTest1'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest1',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('propagates multiple messages through a queue with cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-messages-1'),
          predicate: azureInvokeGroup('ServiceBus queueTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'ServiceBus queueTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'servicebus',
              'messaging.destination.name': 'queue.1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates a single amqp message through a queue with cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-amqp-message-1'),
          predicate: azureInvokeGroup('ServiceBus queueTest1'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest1',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.1',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('propagates multiple amqp messages through a queue with cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-amqp-messages-1'),
          predicate: azureInvokeGroup('ServiceBus queueTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'ServiceBus queueTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'servicebus',
              'messaging.destination.name': 'queue.1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates a message batch through a queue with cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-message-batch-1'),
          predicate: azureInvokeGroup('ServiceBus queueTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'ServiceBus queueTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'servicebus',
              'messaging.destination.name': 'queue.1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates a single message through a queue with cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-message-2'),
          predicate: azureInvokeGroup('ServiceBus queueTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('propagates multiple messages through a queue with cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-messages-2'),
          predicate: azureInvokeGroup('ServiceBus queueTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)

      it('propagates a single amqp message through a queue with cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-amqp-message-2'),
          predicate: azureInvokeGroup('ServiceBus queueTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('propagates multiple amqp messages through a queue with cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-amqp-messages-2'),
          predicate: azureInvokeGroup('ServiceBus queueTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)

      it('propagates a message batch through a queue with cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-message-batch-2'),
          predicate: azureInvokeGroup('ServiceBus queueTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'ServiceBus queueTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'servicebus',
            'messaging.destination.name': 'queue.2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)
    })

    describe('with batch links disabled', () => {
      let agent
      let proc

      before(async function () {
        this.timeout(60000)
        agent = await new FakeAgent().start()
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, {
          PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
          DD_TRACE_AZURE_SERVICEBUS_BATCH_LINKS_ENABLED: 'false',
        })
      })

      after(async () => {
        await stopProc(proc, { signal: 'SIGINT' })
        await agent.stop()
      })

      it('should not create a tryAdd span or add span links to arrays when batch links are disabled', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-messages-2'),
          predicate: (group) => azureInvokeGroup('ServiceBus queueTest2')(group) || azureCreateGroup(group),
        })
        const sbGroups = groups.filter(azureInvokeGroup('ServiceBus queueTest2'))
        const createGroups = groups.filter(azureCreateGroup)
        assert.ok(sbGroups.length >= 1)
        assert.strictEqual(createGroups.length, 0)
        assert.ok(!('_dd.span_links' in sbGroups[0][0].meta))
      }).timeout(60000)

      it('should not create a tryAdd span or add span links to batches when batch links are disabled', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/send-message-batch-2'),
          predicate: (group) => azureInvokeGroup('ServiceBus queueTest2')(group) || azureCreateGroup(group),
        })
        const sbGroups = groups.filter(azureInvokeGroup('ServiceBus queueTest2'))
        const createGroups = groups.filter(azureCreateGroup)
        assert.ok(sbGroups.length >= 1)
        assert.strictEqual(createGroups.length, 0)
        assert.ok(!('_dd.span_links' in sbGroups[0][0].meta))
      }).timeout(60000)
    })
  })
})

function parseLinks (span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'amqplib,amqp10,rhea,net',
    ...additionalEnvArgs,
  }
  return spawnProc(command, args, { cwd, env }, stdioHandler)
}

function spawnProc (command, args, options = {}, stdioHandler, stderrHandler) {
  const proc = spawn(command, args, { ...options, stdio: 'pipe' })
  return new Promise((resolve, reject) => {
    proc
      .on('error', reject)
      .on('exit', code => {
        if (code !== 0) {
          reject(new Error(`Process exited with status code ${code}.`))
        }
        resolve()
      })

    proc.stdout.on('data', data => {
      if (stdioHandler) {
        stdioHandler(data)
      }
      // eslint-disable-next-line no-console
      if (!options.silent) console.log(data.toString())

      if (data.toString().includes('Host lock lease acquired by instance')) {
        resolve(proc)
      }
    })

    proc.stderr.on('data', data => {
      if (stderrHandler) {
        stderrHandler(data)
      }
      // eslint-disable-next-line no-console
      if (!options.silent) console.error(data.toString())
    })
  })
}
