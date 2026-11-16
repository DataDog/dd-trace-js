'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const { BUN } = require('../helpers/bun')
const { FakeAgent, useSandbox, sandboxCwd } = require('../helpers')

/**
 * @param {string} filename - Path relative to the sandbox root
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runBun (filename, env) {
  const cwd = sandboxCwd()

  return new Promise((resolve, reject) => {
    const proc = spawn(BUN, [path.join(cwd, filename)], {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
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

describe('Bun Orchestrion CommonJS rewrites', function () {
  this.timeout(60_000)

  useSandbox(['graphql', 'ai@6', '@ai-sdk/openai@3', '@langchain/core', '@langchain/openai', 'postgres@3'])

  let agent

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await agent?.stop()
  })

  /**
   * @param {string} fixture - Fixture name in `bun/orchestrion-cjs/`
   * @param {string} spanName
   * @param {(span: { resource: string, error: number, meta: Record<string, string> }) => void} [assertSpan]
   */
  async function assertSpan (fixture, spanName, assertSpan) {
    const messagePromise = agent.assertMessageReceived(({ payload }) => {
      const span = payload.flat().find(span => span.name === spanName)

      assert.ok(span, `Expected ${spanName} span`)
      assertSpan?.(span)
    }, 20_000)

    const [{ code, stdout, stderr }] = await Promise.all([
      runBun(`bun/orchestrion-cjs/${fixture}.js`, { DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}` }),
      messagePromise,
    ])

    assert.strictEqual(code, 0, `Process exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`)
    assert.match(stdout, /ok/)
  }

  it('should trace graphql execution', async () => {
    await assertSpan('graphql', 'graphql.execute', (span) => {
      assert.strictEqual(span.meta.component, 'graphql')
    })
  })

  it('should trace ai generateText', async () => {
    await assertSpan('ai', 'ai.generateText', (span) => {
      assert.strictEqual(span.resource, 'ai.generateText')
    })
  })

  it('should trace langchain .cjs chat models', async () => {
    await assertSpan('langchain', 'langchain.request', (span) => {
      assert.strictEqual(span.resource, 'langchain.chat_models.openai.ChatOpenAI')
    })
  })

  it('should trace postgres queries from its CommonJS build', async () => {
    await assertSpan('postgres', 'postgres.query', (span) => {
      assert.strictEqual(span.meta.component, 'postgres')
      assert.strictEqual(span.error, 1)
    })
  })
})
