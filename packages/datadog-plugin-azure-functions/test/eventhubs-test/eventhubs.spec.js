'use strict'

const {
  FakeAgent,
  hookFile,
  createSandbox,
  curlAndAssertMessage
} = require('../../../../integration-tests/helpers')
const { spawn } = require('child_process')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // TODO: Allow newer versions in Node.js 18 when their breaking change is reverted.
  // See https://github.com/Azure/azure-functions-nodejs-library/pull/357
  withVersions('azure-functions', '@azure/functions', NODE_MAJOR < 20 ? '<4.7.3' : '*', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await createSandbox([
        `@azure/functions@${version}`,
        '@azure/event-hubs@6.0.0',
        'azure-functions-core-tools@4',
      ],
      false,
      ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
        './packages/datadog-plugin-azure-functions/test/eventhubs-test/*'])
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

    // it('propagates eventdata through an event hub with a cardinality of one', async () => {
    //   const envArgs = {
    //     PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
    //   }
    //   proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func' , ['start'] , agent.port, undefined, envArgs)
    //
    //   return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-eventdata', ({ headers, payload }) => {
    //     // console.log("this is the payload", payload)
    //     assert.strictEqual(payload.length, 4)
    //     assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
    //     assert.strictEqual(payload[2][0].resource, 'EventHub eventHubTest1')
    //     assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
    //     assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhub')
    //     assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
    //     assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
    //     assert.strictEqual(parseLinks(payload[2][0]).length, 1)
    //     assert.strictEqual(payload[3][0].name, 'azure.functions.invoke')
    //     assert.strictEqual(payload[3][0].resource, 'EventHub eventHubTest1')
    //     assert.strictEqual(payload[3][0].meta['messaging.operation'], 'receive')
    //     assert.strictEqual(payload[3][0].meta['messaging.system'], 'eventhub')
    //     assert.strictEqual(payload[3][0].meta['messaging.destination.name'], 'eh1')
    //     assert.strictEqual(payload[3][0].meta['span.kind'], 'consumer')
    //     assert.strictEqual(parseLinks(payload[3][0]).length, 1)
    //   })
    // }).timeout(60000)

    // it('propagates amqp messages through an event hub with a cardinality of one', async () => {
    //   const envArgs = {
    //     PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
    //   }
    //   proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func' , ['start'] , agent.port, undefined, envArgs)

    //   return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eh1-amqpmessages', ({ headers, payload }) => {
    //     // console.log("this is the payload", payload)
    //     assert.strictEqual(payload.length, 4)
    //     assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
    //     assert.strictEqual(payload[2][0].resource, 'EventHub eventHubTest1')
    //     assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
    //     assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhub')
    //     assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh1')
    //     assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
    //     assert.strictEqual(parseLinks(payload[2][0]).length, 1)
    //     assert.strictEqual(payload[3][0].name, 'azure.functions.invoke')
    //     assert.strictEqual(payload[3][0].resource, 'EventHub eventHubTest1')
    //     assert.strictEqual(payload[3][0].meta['messaging.operation'], 'receive')
    //     assert.strictEqual(payload[3][0].meta['messaging.system'], 'eventhub')
    //     assert.strictEqual(payload[3][0].meta['messaging.destination.name'], 'eh1')
    //     assert.strictEqual(payload[3][0].meta['span.kind'], 'consumer')
    //     assert.strictEqual(parseLinks(payload[3][0]).length, 1)
    //   })
    // }).timeout(60000)

    it('propagates a batch through an event hub with a cardinality of one', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func' , ['start'] , agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://localhost:7071/api/eh1-batch', ({ headers, payload }) => {
        // console.log("this is the payload", payload)
        // console.log("this is the payload meta", payload[3][0].meta)
      })
    }).timeout(60000)

    // it('propagates context through an event hub with a cardinality of many', async () => {
    //   const envArgs = {
    //     PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
    //   }
    //   proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func' , ['start'] , agent.port, undefined, envArgs)

    //   return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/eventhubs-test2', ({ headers, payload }) => {
    //     console.log("this is the payload", payload)
    //     const links = JSON.parse(payload[2][0].meta['_dd.span_links'])
    //     expect(links).to.have.lengthOf(4)
    //     assert.strictEqual(payload.length, 4)
    //     assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
    //     assert.strictEqual(payload[2][0].resource, 'EventHub eventHubTest2')
    //     assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
    //     assert.strictEqual(payload[2][0].meta['messaging.system'], 'eventhub')
    //     assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'eh2')
    //     assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
    //   })
    // }).timeout(60000)
  })
})

function parseLinks(span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort
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
