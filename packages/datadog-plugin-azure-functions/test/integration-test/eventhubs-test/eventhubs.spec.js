'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const {
  FakeAgent,
  assertObjectContains,
  hookFile,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  stopProc,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

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
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-eventdata',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 2)
            for (const group of ehGroups) {
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
          })
        )
      }).timeout(60000)

      it('propagates amqp messages through an event hub with a cardinality of one', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-amqpmessages',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 2)
            for (const group of ehGroups) {
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
          })
        )
      }).timeout(60000)

      it('propagates a batch through an event hub with a cardinality of one', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-batch',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 2)
            for (const group of ehGroups) {
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
          })
        )
      }).timeout(60000)

      it('propagates eventData through an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-eventdata',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
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
          })
        )
      }).timeout(60000)

      it('propagates amqp messages through an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-amqpmessages',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
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
          })
        )
      }).timeout(60000)

      it('propagates a batch through an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-batch',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
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
          })
        )
      }).timeout(60000)

      it('enqueues a single event to an event hub with a cardinality of one', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-enqueueEvent',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
            assertObjectContains(ehGroups[0][0], {
              name: 'azure.functions.invoke',
              resource: 'EventHubs eventHubTest1',
              meta: {
                'messaging.operation': 'receive',
                'messaging.system': 'eventhubs',
                'messaging.destination.name': 'eh1',
                'span.kind': 'consumer',
              },
            })
            assert.strictEqual(parseLinks(ehGroups[0][0]).length, 1)
          })
        )
      }).timeout(60000)

      it('enqueues events to an event hub with a cardinality of one', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-enqueueEvents',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 2)
            for (const group of ehGroups) {
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
          })
        )
      }).timeout(60000)

      it('enqueues amqp messages to an event hub with a cardinality of one', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh1-enqueueAmqp',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 2)
            for (const group of ehGroups) {
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
          })
        )
      }).timeout(60000)

      it('enqueues a single event to an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-enqueueEvent',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
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
            assert.strictEqual(parseLinks(ehGroups[0][0]).length, 1)
          })
        )
      }).timeout(60000)

      it('enqueues events to an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-enqueueEvents',
          collectingAssert(allGroups => {
            const senderGroup = allGroups.find(g => g.some(s => s.name === 'azure.eventhubs.send'))
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.ok(senderGroup)
            assert.strictEqual(ehGroups.length, 1)
            assert.strictEqual(senderGroup[1].name, 'azure.eventhubs.create')
            assert.strictEqual(senderGroup[2].name, 'azure.eventhubs.create')
            assert.strictEqual(senderGroup[3].name, 'azure.eventhubs.send')
            assert.strictEqual(parseLinks(senderGroup[3]).length, 2)
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
          })
        )
      }).timeout(60000)

      it('enqueues amqp messages to an event hub with a cardinality of many', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-enqueueAmqp',
          collectingAssert(allGroups => {
            const senderGroup = allGroups.find(g => g.some(s => s.name === 'azure.eventhubs.send'))
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.ok(senderGroup)
            assert.strictEqual(ehGroups.length, 1)
            assert.strictEqual(senderGroup[1].name, 'azure.eventhubs.create')
            assert.strictEqual(senderGroup[2].name, 'azure.eventhubs.create')
            assert.strictEqual(senderGroup[3].name, 'azure.eventhubs.send')
            assert.strictEqual(parseLinks(senderGroup[3]).length, 2)
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
          })
        )
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

      it('should add span links to non-batched messages when batch links are disabled', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-eventdata',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
            assert.ok('_dd.span_links' in ehGroups[0][0].meta)
          })
        )
      }).timeout(60000)

      it('should not create a tryAdd span or add span links to batches when batch links are disabled', async () => {
        return curlAndAssertMessage(
          agent,
          'http://127.0.0.1:7071/api/eh2-batch',
          collectingAssert(allGroups => {
            const ehGroups = allGroups.filter(g => isEhInvokeGroup(g))
            const nonEhGroups = allGroups.filter(g => !isEhInvokeGroup(g))
            assert.strictEqual(ehGroups.length, 1)
            assert.ok(nonEhGroups.length > 0)
            const hasCreateSpan = nonEhGroups.some(g => g.some(s => s.name === 'azure.functions.create'))
            assert.strictEqual(hasCreateSpan, false)
            assert.ok(!('_dd.span_links' in ehGroups[0][0].meta))
          })
        )
      }).timeout(60000)
    })
  })
})

function isEhInvokeGroup (group) {
  return group.some(s => s.name === 'azure.functions.invoke' && s.resource?.startsWith('EventHubs'))
}

function collectingAssert (fn) {
  const allGroups = []
  return ({ payload }) => {
    allGroups.push(...payload)
    fn(allGroups)
  }
}

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
