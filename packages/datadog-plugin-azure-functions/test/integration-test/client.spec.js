'use strict'

const {
  FakeAgent,
  hookFile,
  createSandbox,
  curlAndAssertMessage
} = require('../../../../integration-tests/helpers')
const { spawn } = require('child_process')
const { assert } = require('chai')
const findProcess = require('find-process')
const waitOn = require('wait-on')

describe('esm', () => {
  let agent
  let command
  let proc
  let sandbox

  withVersions('azure-functions', '@azure/functions', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`@azure/functions@${version}`, 'azure-functions-core-tools@4'], false,
        ['./packages/datadog-plugin-azure-functions/test/integration-test/fixtures/*'])
      command = `${sandbox.folder}/node_modules/.bin/func`
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      const azureFuncProc = await findProcess('name', 'func', true)
      const azureFuncProcPid = azureFuncProc[0]?.pid ?? null
      azureFuncProcPid !== null && process.kill(azureFuncProcPid, 'SIGKILL')

      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, command, ['start'], agent.port)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httpexample', ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'azure-functions.invoke')
      })
    }).timeout(50000)
  })
})

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort) {
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    PATH: `${process.execPath}:${process.env.PATH}` // Pass node path to child process
  }

  return await spawnProc(command, args, {
    cwd,
    env
  })
}

async function spawnProc (command, args, options = {}) {
  const proc = spawn(command, args, { ...options, stdio: 'pipe' })
  await waitOn({
    resources: ['http-get://127.0.0.1:7071'],
    timeout: 5000
  })
  return proc
}
