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
  curl,
  assertObjectContains,
  stopProc,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  withVersions('azure-functions', '@azure/functions', version => {
    let agent
    let proc
    let setup
    let teardown
    let cosmosClient

    useSandbox([
      `@azure/functions@${version}`,
      'azure-functions-core-tools@4',
      '@azure/cosmos@4.9.2',
    ],
    false,
    ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
      './packages/datadog-plugin-azure-functions/test/integration-test/cosmosdb-test/*'])

    before(async function () {
      this.timeout(60000)
      const helpers = await import(pathToFileURL(path.join(sandboxCwd(), 'cosmosdb-helpers.mjs')).href)
      setup = helpers.setup
      teardown = helpers.teardown

      agent = await new FakeAgent().start()
      cosmosClient = await setup()

      const envArgs = {
        PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
      }
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, envArgs)
    })

    after(async () => {
      await stopProc(proc, { signal: 'SIGINT' })
      await teardown(cosmosClient)
      await agent.stop()
    })

    it('propagates cosmosdb writes to azure function trigger', async () => {
      const isHttpInvokeGroup = group =>
        group.some(s => s?.name === 'azure.functions.invoke' && s.resource === 'GET /api/writeToCosmos')
      const isTriggerGroup = group =>
        group.some(s => s?.name === 'azure.functions.invoke' && s.resource === 'CosmosDB cosmosDBTrigger1')

      const groups = await agent.collectGroups({
        trigger: () => curl('http://127.0.0.1:7071/api/writeToCosmos'),
        predicate: group => isHttpInvokeGroup(group) || isTriggerGroup(group),
        expectedCount: 2,
        timeout: 120000,
      })

      const httpGroup = groups.find(isHttpInvokeGroup)
      const triggerGroup = groups.find(isTriggerGroup)

      assert.ok(httpGroup, 'expected writeToCosmos HTTP invoke span')
      assert.ok(triggerGroup, 'expected CosmosDB trigger invoke span')

      const cosmosQueryCount = httpGroup.filter(s => s?.name === 'cosmosdb.query').length
      assert.ok(cosmosQueryCount >= 2, `expected cosmosdb.query spans; found ${cosmosQueryCount}`)

      const triggerSpan = triggerGroup.find(
        s => s?.name === 'azure.functions.invoke' && s.resource === 'CosmosDB cosmosDBTrigger1'
      )
      assertObjectContains(triggerSpan, {
        name: 'azure.functions.invoke',
        resource: 'CosmosDB cosmosDBTrigger1',
        type: 'serverless',
        meta: {
          'aas.function.trigger': 'CosmosDB',
          'aas.function.name': 'cosmosDBTrigger1',
        },
      })
    }).timeout(120000)
  })
})

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile} --experimental-global-webcrypto`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'http,dns,net',
  }
  env = { ...env, ...additionalEnvArgs }
  return spawnProc(command, args, {
    cwd,
    env,
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
