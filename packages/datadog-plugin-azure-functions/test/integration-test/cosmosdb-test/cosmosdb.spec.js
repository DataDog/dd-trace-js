'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { spawn } = require('child_process')
const {
  FakeAgent,
  hookFile,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  assertObjectContains,
  stopProc,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let setup
  let teardown

  withVersions('azure-functions', '@azure/functions', version => {
    useSandbox([
      `@azure/functions@${version}`,
      'azure-functions-core-tools@4',
      '@azure/event-hubs@6.0.0',
      '@azure/cosmos@4.9.2',
    ],
      false,
      ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
        './packages/datadog-plugin-azure-functions/test/integration-test/cosmosdb-test/*'])

    before(async function () {
      const helpers = await import(pathToFileURL(path.join(sandboxCwd(), 'cosmosdb-helpers.mjs')).href)
      setup = helpers.setup
      teardown = helpers.teardown
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      await setup()
    })

    afterEach(async () => {
      await stopProc(proc, { signal: 'SIGINT' })
      await teardown()
      await agent.stop()
    })

    it('propagates cosmosdb writes to azure function trigger', async () => {
      const envArgs = {
        PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
      }
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/writeToCosmos', ({ headers, payload }) => {
        assert.ok(Array.isArray(payload), 'trace payload should be an array of traces')

        const writeTrace = payload.find(
          trace =>
            Array.isArray(trace) &&
            trace.length === 4 &&
            trace[0]?.name === 'azure.functions.invoke' &&
            trace[1]?.name === 'cosmosdb.query' &&
            trace[2]?.name === 'cosmosdb.query' &&
            trace[3]?.name === 'cosmosdb.query'
        )
        assert.ok(
          writeTrace,
          `expected HTTP write trace (invoke + 3 cosmosdb.query); had ${payload.length} top-level traces`
        )

        const triggerTrace = payload.find(
          trace =>
            Array.isArray(trace) &&
            trace.length >= 1 &&
            trace[0]?.name === 'azure.functions.invoke' &&
            trace[0]?.meta?.['aas.function.trigger'] === 'CosmosDB' &&
            trace[0]?.meta?.['aas.function.name'] === 'cosmosDBTrigger1'
        )
        assert.ok(triggerTrace, 'expected CosmosDB trigger invoke trace')

        assertObjectContains(triggerTrace[0], {
          name: 'azure.functions.invoke',
          resource: 'CosmosDB cosmosDBTrigger1',
          type: 'serverless',
          meta: {
            'aas.function.trigger': 'CosmosDB',
            'aas.function.name': 'cosmosDBTrigger1',
          },
        })
      })
    }).timeout(120000)
  })
})

async function spawnPluginIntegrationTestProc(cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'http,dns,net',
  }
  env = { ...env, ...additionalEnvArgs }
  return spawnProc(command, args, {
    cwd,
    env,
  }, stdioHandler)
}

function spawnProc(command, args, options = {}, stdioHandler, stderrHandler) {
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
