'use strict'

const assert = require('node:assert/strict')

const { spawn } = require('child_process')
const {
  FakeAgent,
  assertObjectContains,
  hookFile,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  stopProc,
} = require('../../../../../integration-tests/helpers')
const { withVersions } = require('../../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  withVersions('azure-functions', '@azure/functions', version => {
    useSandbox([
      `@azure/functions@${version}`,
      'azure-functions-core-tools@4',
    ],
    false,
    ['./packages/datadog-plugin-azure-functions/test/fixtures/*',
      './packages/datadog-plugin-azure-functions/test/integration-test/http-test/*'])

    describe('with Datadog semantics', () => {
      let agent
      let proc

      before(async function () {
        this.timeout(60000)
        agent = await new FakeAgent().start()
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, {
          PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
        })
      })

      after(async () => {
        await stopProc(proc, { signal: 'SIGINT' })
        await agent.stop()
      })

      // TODO(bengl): The `varySandbox` helper function isn't well set-up for dealing
      // with Azure Functions and the way the `func` command expects to find files. I
      // have manually tested that all the usual import variants work, but really we ought
      // to figure out a way of automating this.
      it('is instrumented', async () => {
        return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest', ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)

          assertObjectContains(payload, [[{
            name: 'azure.functions.invoke',
            meta: {
              '_dd.integration': 'azure-functions',
              component: 'azure-functions',
              'http.route': '/api/httptest',
            },
            resource: 'GET /api/httptest',
          }]])
        })
      }).timeout(60_000)

      it('propagates context to child http requests', async () => {
        return curlAndAssertMessage(agent, 'http://127.0.0.1:7071/api/httptest2', ({ payload }) => {
          assert.strictEqual(payload.length, 2)
          assert.strictEqual(payload[1][0].span_id, payload[1][1].parent_id)
        })
      }).timeout(50000)
    })

    describe('with OTel semantics', () => {
      let agent
      let proc

      before(async function () {
        this.timeout(60000)
        agent = await new FakeAgent().start()
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'func', ['start'], agent.port, undefined, {
          DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
          DD_TRACE_SAMPLING_RULES: JSON.stringify([
            { resource: 'GET /api/httptest2', sample_rate: 0.5 },
          ]),
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/traces`,
          PATH: `${sandboxCwd()}/node_modules/azure-functions-core-tools/bin:${process.env.PATH}`,
        })
      })

      after(async () => {
        await stopProc(proc, { signal: 'SIGINT' })
        await agent.stop()
      })

      it('uses the route for sampling before outbound propagation', async () => {
        const spanPromise = waitForOtlpSpan(agent, 'GET /api/httptest2', 50_000)
        const response = await fetch('http://127.0.0.1:7071/api/httptest2', {
          headers: {
            'x-datadog-parent-id': '2',
            'x-datadog-trace-id': '1',
          },
        })
        assert.strictEqual(response.status, 200)
        await response.text()

        const span = await spanPromise
        assertObjectContains(span.attributes, [
          { key: '_dd.p.ksr', value: { stringValue: '0.5' } },
          { key: '_sampling_priority_v1', value: { intValue: 2 } },
        ])
      }).timeout(60_000)
    })
  })
})

/**
 * @typedef {object} OtlpSpan
 * @property {string} name
 * @property {Array<{key: string, value: Record<string, string | number>}>} attributes
 */

/**
 * @typedef {object} OtlpTracePayload
 * @property {Array<{scopeSpans: Array<{spans: OtlpSpan[]}>}>} resourceSpans
 */

/**
 * @param {FakeAgent} agent
 * @param {string} name
 * @param {number} timeout
 * @returns {Promise<OtlpSpan>}
 */
function waitForOtlpSpan (agent, name, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.off('otlp-traces', onTraces)
      reject(new Error(`Timed out waiting for OTLP span ${name}`))
    }, timeout)

    /** @param {{ payload: OtlpTracePayload }} message */
    function onTraces ({ payload }) {
      for (const resourceSpan of payload.resourceSpans) {
        for (const scopeSpan of resourceSpan.scopeSpans) {
          for (const span of scopeSpan.spans) {
            if (span.name !== name) continue

            clearTimeout(timer)
            agent.off('otlp-traces', onTraces)
            resolve(span)
            return
          }
        }
      }
    }

    agent.on('otlp-traces', onTraces)
  })
}

async function spawnPluginIntegrationTestProc (cwd, command, args, agentPort, stdioHandler, additionalEnvArgs = {}) {
  const env = {
    NODE_OPTIONS: `--loader=${hookFile}`,
    DD_TRACE_AGENT_PORT: agentPort,
    ...additionalEnvArgs,
  }
  return spawnProc(command, args, { cwd, env }, stdioHandler)
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
