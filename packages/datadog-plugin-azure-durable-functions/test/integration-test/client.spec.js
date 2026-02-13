'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const { describe, it } = require('mocha')
const {
  FakeAgent,
  hookFile,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let azuriteproc
  let funcproc

  withVersions('azure-durable-functions', 'durable-functions', version => {
    useSandbox([
      `durable-functions@${version}`,
      '@azure/functions',
      'azure-functions-core-tools@4',
      'azurite@3',
    ],
    false,
    ['./packages/datadog-plugin-azure-durable-functions/test/integration-test/*',
      './packages/datadog-plugin-azure-durable-functions/test/fixtures/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start();
      [azuriteproc, funcproc] = await spawnPluginIntegrationTestProcs(agent.port)
    })

    afterEach(async () => {
      // after each test, kill both processes and wait for them to exit before continuing

      if (funcproc) {
        funcproc.kill('SIGINT')
        await new Promise(resolve => funcproc.on('exit', resolve))
      }
      if (azuriteproc) {
        azuriteproc.kill('SIGINT')
        await new Promise(resolve => azuriteproc.on('exit', resolve))
      }
      await agent.stop()
    })

    it('is instrumented', async () => {
      return await curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))

        // should expect spans for http.request, activity.hola, entity.counter.add_n, entity.counter.get_count
        assert.strictEqual(payload.length, 4)

        for (const maybeArray of payload) {
          assert.ok(Array.isArray(maybeArray))
        }

        const [maybeHttpSpan, maybeHolaActivity, maybeAddNEntity, maybeGetCountEntity] = payload

        assert.strictEqual(maybeHttpSpan.length, 2)
        assert.strictEqual(maybeHttpSpan[0].resource, 'GET /api/httptest')

        assert.strictEqual(maybeHolaActivity.length, 1)
        assert.strictEqual(maybeHolaActivity[0].resource, 'Activity hola')
        assert.strictEqual(maybeHolaActivity[0].name, 'azure.durable-functions.invoke')

        assert.strictEqual(maybeAddNEntity.length, 1)
        assert.strictEqual(maybeAddNEntity[0].resource, 'Entity Counter add_n')
        assert.strictEqual(maybeAddNEntity[0].name, 'azure.durable-functions.invoke')

        assert.strictEqual(maybeGetCountEntity.length, 1)
        assert.strictEqual(maybeGetCountEntity[0].resource, 'Entity Counter get_count')
        assert.strictEqual(maybeGetCountEntity[0].name, 'azure.durable-functions.invoke')
      })
    }).timeout(60000)
  })
})

/**
 * spawns processes for azurite and func start commands
 * - azurite is spawned first and is used as a local storage for durable functions
 * - func start then connects to azurite and runs the durable function locally
 */
async function spawnPluginIntegrationTestProcs (agentPort) {
  const cwd = sandboxCwd()
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'amqplib,amqp10,rhea,net',
    PATH: `${cwd}/node_modules/azure-functions-core-tools/bin:` +
    `${cwd}/node_modules/.bin:${process.env.PATH}`,
  }

  // callbacks to check logs if azurite and func-start proccesess are ready
  const azuriteReadyCondition = (dataString) => {
    return dataString.includes('Azurite Table service is successfully listening')
  }

  const funcReadyCondition = (dataString) => {
    return dataString.toString().includes('Host lock lease acquired by instance')
  }

  const options = { cwd, env }

  const azuriteProc = await spawnProc('azurite', ['-s'], options, azuriteReadyCondition)

  const funcProc = await spawnProc('func', ['start'], options, funcReadyCondition)
  return [azuriteProc, funcProc]
}

function spawnProc (command, args, options = {}, readyCondition) {
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
      // eslint-disable-next-line no-console
      if (!options.silent) console.log(data.toString())

      if (readyCondition(data.toString())) {
        resolve(proc)
      }
    })

    proc.stderr.on('data', data => {
      // eslint-disable-next-line no-console
      if (!options.silent) console.error(data.toString())
    })
  })
}
