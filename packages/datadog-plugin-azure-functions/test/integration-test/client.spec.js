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

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // TODO: Allow newer versions in Node.js 18 when their breaking change is reverted.
  // See https://github.com/Azure/azure-functions-nodejs-library/pull/357
  withVersions('azure-functions', '@azure/functions', NODE_MAJOR < 20 ? '<4.7.3' : '*', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([
        `@azure/functions@${version}`,
        'azure-functions-core-tools@4.1.0',
        '@azure/service-bus@7.9.2'
      ],
      false,
      ['./packages/datadog-plugin-azure-functions/test/integration-test/fixtures/*'])
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

    it('is instrumented', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'azure.functions.invoke')
      })
    }).timeout(50000)

    it('propagates context to child http requests', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest2', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 2)
        assert.strictEqual(payload[1][0].span_id, payload[1][1].parent_id)
      })
    }).timeout(50000)

    it('propagates context through a service bus queue', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest3', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][1].span_id, payload[2][0].parent_id)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'ServiceBus queueTest')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'queue.1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'servicebus')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
      })
    }).timeout(50000)

    it('propagates context through a service bus topic', async () => {
      const envArgs = {
        PATH: `${sandbox.folder}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest4', ({ headers, payload }) => {
        assert.strictEqual(payload.length, 3)
        assert.strictEqual(payload[1][1].span_id, payload[2][0].parent_id)
        assert.strictEqual(payload[2][0].name, 'azure.functions.invoke')
        assert.strictEqual(payload[2][0].resource, 'ServiceBus topicTest')
        assert.strictEqual(payload[2][0].meta['messaging.destination.name'], 'topic.1')
        assert.strictEqual(payload[2][0].meta['messaging.operation'], 'receive')
        assert.strictEqual(payload[2][0].meta['messaging.system'], 'servicebus')
        assert.strictEqual(payload[2][0].meta['span.kind'], 'consumer')
      })
    }).timeout(50000)
  })
})

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

      if (data.toString().includes('http://localhost:7071/api/httptest')) {
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
