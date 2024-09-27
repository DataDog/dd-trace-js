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
  let proc
  let sandbox

  withVersions('azure-functions', '@azure/functions', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`@azure/functions@${version}`, 'azure-functions-core-tools@4'], false,
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
      const azureFuncProc = await findProcess('name', 'func', true)
      const azureFuncProcPid = azureFuncProc[0]?.pid ?? null
      azureFuncProcPid !== null && process.kill(azureFuncProcPid, 'SIGKILL')

      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const envArgs = {
        PATH: process.env.PATH
      }
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'func', ['start'], agent.port, undefined, envArgs)

      return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
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
    waitOn({
      resources: ['http-get://127.0.0.1:7071'],
      timeout: 5000
    }).then(() => {
      resolve(proc)
    }).catch(err => {
      reject(new Error(`Error while waiting for process to start: ${err.message}`))
    })

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
