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
      '@azure/event-hubs@6.0.0',
    ],
    false,
    ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
      './packages/datadog-plugin-azure-functions/test/integration-test/eventhubs-test/*'])

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

      it('propagates eventdata through an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-eventdata'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'EventHubs eventHubTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'eventhubs',
              'messaging.destination.name': 'eh1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates amqp messages through an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-amqpmessages'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'EventHubs eventHubTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'eventhubs',
              'messaging.destination.name': 'eh1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates a batch through an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-batch'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'EventHubs eventHubTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'eventhubs',
              'messaging.destination.name': 'eh1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('propagates eventData through an event hub with a cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-eventdata'),
          predicate: azureInvokeGroup('EventHubs eventHubTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)

      it('propagates amqp messages through an event hub with a cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-amqpmessages'),
          predicate: azureInvokeGroup('EventHubs eventHubTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)

      it('propagates a batch through an event hub with a cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-batch'),
          predicate: azureInvokeGroup('EventHubs eventHubTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 2)
      }).timeout(60000)

      it('enqueues a single event to an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-enqueueEvent'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest1',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh1',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('enqueues events to an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-enqueueEvents'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'EventHubs eventHubTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'eventhubs',
              'messaging.destination.name': 'eh1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('enqueues amqp messages to an event hub with a cardinality of one', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh1-enqueueAmqp'),
          predicate: azureInvokeGroup('EventHubs eventHubTest1'),
          expectedCount: 2,
        })
        for (const group of groups) {
          assertObjectContains(group[0], {
            name: 'azure.functions.invoke',
            resource: 'EventHubs eventHubTest1',
            meta: {
              'messaging.operation': 'receive',
              'messaging.system': 'eventhubs',
              'messaging.destination.name': 'eh1',
              'span.kind': 'consumer',
            },
          })
          assert.strictEqual(parseLinks(group[0]).length, 1)
        }
      }).timeout(60000)

      it('enqueues a single event to an event hub with a cardinality of many', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-enqueueEvent'),
          predicate: azureInvokeGroup('EventHubs eventHubTest2'),
        })
        assertObjectContains(groups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(groups[0][0]).length, 1)
      }).timeout(60000)

      it('enqueues events to an event hub with a cardinality of many', async () => {
        const senderGroup = (group) => group.some(s => s.name === 'azure.eventhubs.send')
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-enqueueEvents'),
          predicate: (group) => azureInvokeGroup('EventHubs eventHubTest2')(group) || senderGroup(group),
          expectedCount: 2,
        })
        const ehGroups = groups.filter(azureInvokeGroup('EventHubs eventHubTest2'))
        const senderGroups = groups.filter(senderGroup)
        assert.strictEqual(ehGroups.length, 1)
        assert.strictEqual(senderGroups.length, 1)
        assert.strictEqual(senderGroups[0][1].name, 'azure.eventhubs.create')
        assert.strictEqual(senderGroups[0][2].name, 'azure.eventhubs.create')
        assert.strictEqual(senderGroups[0][3].name, 'azure.eventhubs.send')
        assert.strictEqual(parseLinks(senderGroups[0][3]).length, 2)
        assertObjectContains(ehGroups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(ehGroups[0][0]).length, 2)
      }).timeout(60000)

      it('enqueues amqp messages to an event hub with a cardinality of many', async () => {
        const senderGroup = (group) => group.some(s => s.name === 'azure.eventhubs.send')
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-enqueueAmqp'),
          predicate: (group) => azureInvokeGroup('EventHubs eventHubTest2')(group) || senderGroup(group),
          expectedCount: 2,
        })
        const ehGroups = groups.filter(azureInvokeGroup('EventHubs eventHubTest2'))
        const senderGroups = groups.filter(senderGroup)
        assert.strictEqual(ehGroups.length, 1)
        assert.strictEqual(senderGroups.length, 1)
        assert.strictEqual(senderGroups[0][1].name, 'azure.eventhubs.create')
        assert.strictEqual(senderGroups[0][2].name, 'azure.eventhubs.create')
        assert.strictEqual(senderGroups[0][3].name, 'azure.eventhubs.send')
        assert.strictEqual(parseLinks(senderGroups[0][3]).length, 2)
        assertObjectContains(ehGroups[0][0], {
          name: 'azure.functions.invoke',
          resource: 'EventHubs eventHubTest2',
          meta: {
            'messaging.operation': 'receive',
            'messaging.system': 'eventhubs',
            'messaging.destination.name': 'eh2',
            'span.kind': 'consumer',
          },
        })
        assert.strictEqual(parseLinks(ehGroups[0][0]).length, 2)
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
          DD_TRACE_AZURE_EVENTHUBS_BATCH_LINKS_ENABLED: 'false',
        })
      })

      after(async () => {
        await stopProc(proc, { signal: 'SIGINT' })
        await agent.stop()
      })

      // Batch test runs first so its re-triggers (no span links) don't contaminate the
      // eventdata test, which looks for span links.
      it('should not create a tryAdd span or add span links to batches when batch links are disabled', async () => {
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-batch'),
          predicate: (group) => azureInvokeGroup('EventHubs eventHubTest2')(group) || azureCreateGroup(group),
        })
        const ehGroups = groups.filter(azureInvokeGroup('EventHubs eventHubTest2'))
        const createGroups = groups.filter(azureCreateGroup)
        assert.strictEqual(ehGroups.length, 1)
        assert.strictEqual(createGroups.length, 0)
        assert.ok(!('_dd.span_links' in ehGroups[0][0].meta))
      }).timeout(60000)

      // Re-triggers from the previous test (batch, no span links) may arrive during this
      // window, so we look for any EH group that has span links rather than asserting on
      // a fixed count.
      it('should add span links to non-batched messages when batch links are disabled', async () => {
        const hasSpanLinks = (group) =>
          azureInvokeGroup('EventHubs eventHubTest2')(group) && '_dd.span_links' in group[0].meta
        const groups = await agent.collectGroups({
          trigger: () => curl('http://127.0.0.1:7071/api/eh2-eventdata'),
          predicate: hasSpanLinks,
        })
        assert.ok(groups.length >= 1)
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
