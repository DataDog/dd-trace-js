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
  curl,
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

    it('continues the host trace across durable activity and entity invocations', async () => {
      proc = await spawnPluginIntegrationTestProc(agent.port)

      const seenSpans = []
      const assertPromise = agent.assertMessageReceived(({ payload }) => {
        seenSpans.push(...payload.flat())

        const httpSpan = seenSpans.find(span => span.resource === 'GET /api/httptest')
        const activitySpan = seenSpans.find(span => span.resource === 'Activity hola')
        const entitySpans = seenSpans.filter(span => span.meta?.['aas.function.trigger'] === 'Entity')

        if (!httpSpan || !activitySpan || entitySpans.length < 2) {
          throw new Error('waiting for durable activity and entity spans')
        }

        const traceId = httpSpan.trace_id.toString()
        for (const span of [activitySpan, ...entitySpans]) {
          assert.strictEqual(
            span.trace_id.toString(),
            traceId,
            `${span.resource} should share the HTTP trace id`
          )
          assert.notStrictEqual(span.parent_id, 0, `${span.resource} should not be a root span`)
        }
      }, 60_000)

      await curl('http://127.0.0.1:7071/api/httptest')
      return assertPromise
    }).timeout(60_000)

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(agent.port)
      return await curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

        // should expect spans for http.request, activity.hola, entity.counter.add_n, entity.counter.get_count
        assert.strictEqual(payload.length, 4)

        for (const maybeArray of payload) {
          assert.ok(Array.isArray(maybeArray), `Expected array, got ${inspect(maybeArray)}`)
        }

        const [maybeHttpSpan, maybeHolaActivity, maybeAddNEntity, maybeGetCountEntity] = payload

        assert.strictEqual(maybeHttpSpan.length, 2)
        assert.strictEqual(maybeHttpSpan[0].resource, 'GET /api/httptest')

        assert.strictEqual(maybeHolaActivity.length, 1)
        assertObjectContains(maybeHolaActivity[0], {
          name: 'azure.functions.invoke',
          resource: 'Activity hola',
          meta: {
            'aas.function.trigger': 'Activity',
            'aas.function.name': 'hola',
          },
        })

        assert.strictEqual(maybeAddNEntity.length, 1)
        assertObjectContains(maybeAddNEntity[0], {
          name: 'azure.functions.invoke',
          resource: 'Entity counter add_n',
          meta: {
            'aas.function.trigger': 'Entity',
            'aas.function.name': 'counter',
            'aas.function.operation': 'add_n',
          },
        })

        assert.strictEqual(maybeGetCountEntity.length, 1)
        assertObjectContains(maybeGetCountEntity[0], {
          name: 'azure.functions.invoke',
          resource: 'Entity counter get_count',
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
