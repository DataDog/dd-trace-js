'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const { inspect } = require('node:util')
const { describe, it } = require('mocha')
const {
  FakeAgent,
  hookFile,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  assertObjectContains,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('azure-durable-functions', 'durable-functions', version => {
    useSandbox([
      `durable-functions@${version}`,
      '@azure/functions',
      'azure-functions-core-tools@4',
    ],
    false,
    ['./packages/datadog-plugin-azure-durable-functions/test/integration-test/*',
      './packages/datadog-plugin-azure-durable-functions/test/fixtures/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      // after each test, kill process and wait for exit before continuing
      await stopProc(proc, { signal: 'SIGINT' })
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(agent.port)
      return await curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

        // should expect spans for http.request, orchestration.testOrchestrator, activity.hola,
        // entity.counter.add_n, entity.counter.get_count
        assert.strictEqual(payload.length, 5)

        for (const maybeArray of payload) {
          assert.ok(Array.isArray(maybeArray), `Expected array, got ${inspect(maybeArray)}`)
        }

        // The orchestrator is suspended and resumed between the activity and entity calls, so the
        // order its span is flushed in is not stable. Look traces up by resource instead.
        const traces = new Map(payload.map(trace => [trace[0].resource, trace]))
        const durableSpan = resource => {
          const trace = traces.get(resource)
          assert.ok(trace, `Expected a trace for '${resource}', got ${inspect([...traces.keys()])}`)
          assert.strictEqual(trace.length, 1)
          return trace[0]
        }

        const maybeHttpSpan = traces.get('GET /api/httptest')
        assert.ok(maybeHttpSpan, `Expected a trace for 'GET /api/httptest', got ${inspect([...traces.keys()])}`)
        assert.strictEqual(maybeHttpSpan.length, 2)

        assertObjectContains(durableSpan('Orchestration testOrchestrator'), {
          name: 'azure.functions.invoke',
          meta: {
            'aas.function.trigger': 'Orchestration',
            'aas.function.name': 'testOrchestrator',
          },
        })

        assertObjectContains(durableSpan('Activity hola'), {
          name: 'azure.functions.invoke',
          meta: {
            'aas.function.trigger': 'Activity',
            'aas.function.name': 'hola',
          },
        })

        assertObjectContains(durableSpan('Entity counter add_n'), {
          name: 'azure.functions.invoke',
          meta: {
            'aas.function.trigger': 'Entity',
            'aas.function.name': 'counter',
            'aas.function.operation': 'add_n',
          },
        })

        assertObjectContains(durableSpan('Entity counter get_count'), {
          name: 'azure.functions.invoke',
          meta: {
            'aas.function.trigger': 'Entity',
            'aas.function.name': 'counter',
            'aas.function.operation': 'get_count',
          },
        })
      })
    }).timeout(60_000)
  })
})

/**
 * - spawns process for azure func start commands
 * - connects to azurite (running in container)
 *    then runs the durable function locally
 *
 * @param {number} agentPort port the fake agent listens on
 */
async function spawnPluginIntegrationTestProc (agentPort) {
  const cwd = sandboxCwd()
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'amqplib,amqp10,rhea,net',
    PATH: `${cwd}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
  }
  return spawnProc('func', ['start'], { cwd, env })
}

function spawnProc (command, args, options = {}) {
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

      if (data.toString().includes('Host lock lease acquired by instance')) {
        resolve(proc)
      }
    })

    proc.stderr.on('data', data => {
      // eslint-disable-next-line no-console
      if (!options.silent) console.error(data.toString())
    })
  })
}
