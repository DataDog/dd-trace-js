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
        const durableSpan = durableSpanLookup(payload)

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

    it('namespaces spans under aca in an Azure Container App', async () => {
      proc = await spawnPluginIntegrationTestProc(agent.port, { CONTAINER_APP_NAME: 'my-container-app' })
      return await curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        const durableSpan = durableSpanLookup(payload)

        assertObjectContains(durableSpan('Orchestration testOrchestrator'), {
          name: 'azure.functions.invoke',
          meta: {
            'aca.function.trigger': 'Orchestration',
            'aca.function.name': 'testOrchestrator',
          },
        })

        assertObjectContains(durableSpan('Activity hola'), {
          name: 'azure.functions.invoke',
          meta: {
            'aca.function.trigger': 'Activity',
            'aca.function.name': 'hola',
          },
        })

        assertObjectContains(durableSpan('Entity counter add_n'), {
          name: 'azure.functions.invoke',
          meta: {
            'aca.function.trigger': 'Entity',
            'aca.function.name': 'counter',
            'aca.function.operation': 'add_n',
          },
        })

        assertObjectContains(durableSpan('Entity counter get_count'), {
          name: 'azure.functions.invoke',
          meta: {
            'aca.function.trigger': 'Entity',
            'aca.function.name': 'counter',
            'aca.function.operation': 'get_count',
          },
        })
      })
    }).timeout(60_000)
  })
})

// Asserts the common durable payload shape (http.request + orchestration + activity + 2 entity ops)
// and returns a resource->span lookup. The orchestrator is suspended and resumed between the
// activity and entity calls, so the order its span is flushed in is not stable; callers look spans
// up by resource rather than relying on payload order.
function durableSpanLookup (payload) {
  assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
  assert.strictEqual(payload.length, 5)
  for (const maybeArray of payload) {
    assert.ok(Array.isArray(maybeArray), `Expected array, got ${inspect(maybeArray)}`)
  }

  const traces = new Map(payload.map(trace => [trace[0].resource, trace]))

  const maybeHttpSpan = traces.get('GET /api/httptest')
  assert.ok(maybeHttpSpan, `Expected a trace for 'GET /api/httptest', got ${inspect([...traces.keys()])}`)
  assert.strictEqual(maybeHttpSpan.length, 2)

  return resource => {
    const trace = traces.get(resource)
    assert.ok(trace, `Expected a trace for '${resource}', got ${inspect([...traces.keys()])}`)
    assert.strictEqual(trace.length, 1)
    return trace[0]
  }
}

/**
 * - spawns process for azure func start commands
 * - connects to azurite (running in container)
 *    then runs the durable function locally
 *
 * @param {number} agentPort port the fake agent listens on
 * @param {Record<string, string>} [additionalEnvArgs] extra environment variables for the worker
 */
async function spawnPluginIntegrationTestProc (agentPort, additionalEnvArgs = {}) {
  const cwd = sandboxCwd()
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    DD_TRACE_DISABLED_PLUGINS: 'amqplib,amqp10,rhea,net',
    PATH: `${cwd}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
    ...additionalEnvArgs,
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
