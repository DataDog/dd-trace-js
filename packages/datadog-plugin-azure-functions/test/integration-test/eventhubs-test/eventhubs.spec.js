'use strict'

const {
  FakeAgent,
  hookFile,
  linkedSandbox,
  curlAndAssertMessage,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')
const { spawn } = require('child_process')
const { expect, assert } = require('chai')
const { NODE_MAJOR } = require('../../../../../version')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // TODO: Allow newer versions in Node.js 18 when their breaking change is reverted.
  // See https://github.com/Azure/azure-functions-nodejs-library/pull/357
  withVersions('azure-functions', '@azure/functions', NODE_MAJOR < 20 ? '<4.7.3' : '*', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await linkedSandbox([
        `@azure/functions@${version}`,
        'azure-functions-core-tools@4',
        '@azure/event-hubs@6.0.0',
      ],
      false,
      ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
        './packages/datadog-plugin-azure-functions/test/integration-test/eventhubs-test/*'])
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill('SIGINT')
      await agent.stop()
    })

    it('propagates eventdata through an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-eventdata', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[2][0]).length, 1)
      })
    }).timeout(60000)

    it('propagates amqp messages through an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-amqpmessages', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[2][0]).length, 1)
      })
    }).timeout(60000)

    it('propagates a batch through an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-batch', ({ headers, payload }) => {
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[2][0]).length, 1)
      })
    }).timeout(60000)

    it('propagates eventData through an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-eventdata', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 2)
      })
    }).timeout(60000)

    it('propagates amqp messages through an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-amqpmessages', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 2)
      })
    }).timeout(60000)

    it('propagates a batch through an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-batch', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 2)
      })
    }).timeout(60000)

    it('enqueues a single event to an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-enqueueEvent', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
      })
    }).timeout(60000)

    it('enqueues events to an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-enqueueEvents', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[2][0]).length, 1)
      })
    }).timeout(60000)

    it('enqueues amqp messages to an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-enqueueAmqp', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'EventHubs eventHubTest1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[2][0]).length, 1)
      })
    }).timeout(60000)

    it('enqueues a single event to an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-enqueueEvent', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 1)
      })
    }).timeout(60000)

    it('enqueues events to an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-enqueueEvents', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[0][1].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[0][2].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[0][3].name, 'azure.eventhubs.send')
        assert.strictEqual(parseLinks(payload[0][3]).length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 2)
      })
    }).timeout(60000)

    it('enqueues amqp messages to an event hub with a cardinality of many', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-enqueueAmqp', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[0][1].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[0][2].name, 'azure.eventhubs.create')
        assert.strictEqual(payload[0][3].name, 'azure.eventhubs.send')
        assert.strictEqual(parseLinks(payload[0][3]).length, 2)
        assert.strictEqual(payload[1][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[1][0].resource, 'EventHubs eventHubTest2')
        assert.strictEqual(payload[1][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[1][0].meta['messaging.system'], 'eventhubs')
        assert.strictEqual(payload[1][0].meta['messaging.destination.name'], 'eh2')
        assert.strictEqual(payload[1][0].meta['span.kind'], 'consumer')
        assert.strictEqual(parseLinks(payload[1][0]).length, 2)
      })
    }).timeout(60000)

    it('should add span links to non-batched messages when batch links are disabled', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
        DD_TRACE_AZURE_EVENTHUBS_BATCH_LINKS_ENABLED: false
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)
      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-eventdata', ({ headers, payload }) => {
        expect(payload[1][0].meta).to.have.property('_dd.span_links')
      })
    }).timeout(60000)

    it('should not create a tryAdd span or add span links to batches when batch links are disabled', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
        DD_TRACE_AZURE_EVENTHUBS_BATCH_LINKS_ENABLED: false
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)
      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh2-batch', ({ headers, payload }) => {
        const hasCreateSpan = payload[0].some(obj => obj.name === 'azure.functions.create')
        assert.strictEqual(hasCreateSpan, false)
        expect(payload[1][0].meta).to.not.have.property('_dd.span_links')
      })
    }).timeout(60000)
  })
})

function parseLinks (span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'amqplib,amqp10,rhea,net'
  }
  env = { ...env, ...additionalEnvArgs }
  return spawnProc(command, args, {
    cwd,
    env
  }, stdioHandler)
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
