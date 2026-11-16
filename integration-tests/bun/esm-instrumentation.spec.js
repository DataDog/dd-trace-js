'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const msgpack = require('@msgpack/msgpack')

const { BUN } = require('../helpers/bun')
const { FakeAgent, assertObjectContains, sandboxCwd, useSandbox } = require('../helpers')

/**
 * Runs a fixture under Bun with the tracer preloaded through `dd-trace/initialize.mjs`.
 *
 * @param {string} filename - Fixture name inside `bun/esm-instrumentation`
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runBun (filename, env = {}) {
  const cwd = sandboxCwd()
  const fixture = path.join(cwd, 'bun', 'esm-instrumentation', filename)

  return new Promise((resolve, reject) => {
    const proc = spawn(BUN, ['--preload', 'dd-trace/initialize.mjs', fixture], {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_TRACE_FLUSH_INTERVAL: '10',
        ...env,
      },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data })
    proc.stderr.on('data', (data) => { stderr += data })
    proc.once('error', reject)
    proc.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * @param {{ code: number | null, stdout: string, stderr: string }} result
 */
function assertBunSuccess ({ code, stdout, stderr }) {
  assert.strictEqual(code, 0, `Process exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`)
  assert.match(stdout, /^ok$/m)
}

/**
 * @param {unknown} value
 */
function decodeMetaStruct (value) {
  assert.ok(value, 'Expected LLM Observability data in meta_struct')
  return value instanceof Uint8Array ? msgpack.decode(value) : value
}

/**
 * @param {string} stdout
 */
function getInjectedLog (stdout) {
  const line = stdout.split('\n').find(line => line.includes('"esm log"'))
  assert.ok(line, `Expected a log line in stdout, got: ${stdout}`)

  return JSON.parse(line)
}

describe('Bun ESM instrumentation', function () {
  this.timeout(60_000)

  useSandbox(['openai', 'pino', 'ai@5', 'zod'])

  let agent
  let env

  beforeEach(async function () {
    agent = await new FakeAgent().start()
    env = { DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}` }
  })

  afterEach(async () => {
    await agent.stop()
  })

  it('wraps imported ES modules with import-in-the-middle hooks', async () => {
    const tracesPromise = agent.assertMessageReceived(({ payload }) => {
      const span = payload.flat().find(span => span.name === 'openai.request')
      assert.ok(span, 'Expected an openai.request span')
      assertObjectContains(span, {
        resource: 'createChatCompletion',
        meta: { 'openai.request.model': 'gpt-4o-mini' },
      })

      const llmobs = decodeMetaStruct(span.meta_struct?._llmobs)
      assertObjectContains(llmobs, {
        name: 'OpenAI.createChatCompletion',
        ml_app: 'bun-test',
        meta: {
          span: { kind: 'llm' },
          model_name: 'gpt-4o-mini',
          input: { messages: [{ role: 'user', content: 'Hello' }] },
          output: { messages: [{ role: 'assistant', content: 'Hello from Bun' }] },
        },
        metrics: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      })
    }, 20_000)

    const [result] = await Promise.all([
      runBun('openai.mjs', {
        ...env,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'bun-test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
      }),
      tracesPromise,
    ])

    assertBunSuccess(result)
  })

  it('injects trace context into logs of an imported CommonJS package', async () => {
    const result = await runBun('pino.mjs', { ...env, DD_LOGS_INJECTION: 'true' })

    assertBunSuccess(result)
    const log = getInjectedLog(result.stdout)
    assert.match(log.dd?.trace_id, /^[\da-f]{32}$/)
    assert.match(log.dd?.span_id, /^\d+$/)
  })

  it('shares one hooked module between require and import of a CommonJS package', async () => {
    const result = await runBun('pino-require.mjs', { ...env, DD_LOGS_INJECTION: 'true' })

    assertBunSuccess(result)
    assert.match(getInjectedLog(result.stdout).dd?.trace_id, /^[\da-f]{32}$/)
  })

  it('applies Orchestrion rewrites to imported ES modules', async () => {
    const tracesPromise = agent.assertMessageReceived(({ payload }) => {
      const names = payload.flat().map(span => span.name)
      assert.ok(names.includes('ai.generateText'), `Expected an ai.generateText span, got: ${names}`)
      assert.ok(names.includes('ai.generateText.doGenerate'), `Expected a doGenerate span, got: ${names}`)
    }, 20_000)

    const [result] = await Promise.all([runBun('ai.mjs', env), tracesPromise])

    assertBunSuccess(result)
  })
})
