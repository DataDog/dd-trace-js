'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const {
  FakeAgent,
  assertObjectContains,
  hookFile,
  sandboxCwd,
  useSandbox,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('azure-functions', '@azure/functions', version => {
    useSandbox([
      `@azure/functions@${version}`,
      'azure-functions-core-tools@4',
    ],
    false,
    ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
      './packages/datadog-plugin-azure-functions/test/integration-test/timer-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill('SIGINT')
      await agent.stop()
    })

    it('creates a root span for non-http triggers (extractTraceContext returns null)', async () => {
      const envArgs = {
        PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
      }
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, envArgs)

      await agent.assertMessageReceived(({ payload }) => {
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 1)
        assert.ok(Array.isArray(payload[0]))
        assert.strictEqual(payload[0].length, 1)

        const span = payload[0][0]
        assert.strictEqual(span.name, 'azure.functions.invoke')
        assert.ok(!span.parent_id)
        assertObjectContains(span.meta, {
          'aas.function.trigger': 'Unknown',
        })
      }, 60_000)
    }).timeout(60_000)
  })
})

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  let env = {
    NODE_OPTIONS: `--loader=${hookFile} func start`,
    DD_TRACE_AGENT_PORT: agentPort,
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
        resolve(undefined)
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

