'use strict'

const assert = require('assert')
const { existsSync } = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { BUN } = require('../helpers/bun')
const { FakeAgent, useSandbox, sandboxCwd } = require('../helpers')

/**
 * Spawn a file under the Bun runtime inside the test sandbox.
 *
 * @param {string} filename - Path relative to the sandbox root
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runBun (filename, env = {}) {
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

/**
 * @param {{ code: number | null, stdout: string, stderr: string }} result
 */
function assertBunSuccess (result) {
  const { code, stdout, stderr } = result

  assert.strictEqual(code, 0, `Process exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`)
  assert.ok(stdout.includes('ok'), `Expected "ok" in stdout, got: ${stdout}`)
}

describe('Bun runtime smoke tests', function () {
  before(function () {
    if (!existsSync(BUN)) this.skip()
  })

  useSandbox()

  describe('init order compatibility', () => {
    it('should init tracer via CJS require', async function () {
      this.timeout(30_000)
      assertBunSuccess(await runBun('bun/init-cjs.js'))
    })

    it('should init tracer after ESM JSON import (issue #7480)', async function () {
      this.timeout(30_000)
      assertBunSuccess(await runBun('bun/init-esm-json-import.mjs'))
    })

    it('should init tracer when ESM imports dd-trace before package.json', async function () {
      this.timeout(30_000)
      assertBunSuccess(await runBun('bun/init-esm-dd-trace-first.mjs'))
    })

    it('should init tracer when CJS requires package.json before init', async function () {
      this.timeout(30_000)
      assertBunSuccess(await runBun('bun/init-cjs-json-before-init.js'))
    })

    it('should init tracer when CJS requires package.json after init', async function () {
      this.timeout(30_000)
      assertBunSuccess(await runBun('bun/init-cjs-json-after-init.js'))
    })
  })

  it('should send trace payload with Bun runtime header', async function () {
    this.timeout(30_000)

    const agent = await new FakeAgent().start()

    try {
      const messagePromise = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers['datadog-meta-lang-interpreter'], 'JavaScriptCore')
        assert.ok(Array.isArray(payload), 'Expected trace payload array')
        assert.ok(payload.length > 0, 'Expected at least one trace')
      }, 20_000)

      assertBunSuccess(await runBun('bun/export-span.js', {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      }))
      await messagePromise
    } finally {
      await agent.stop()
    }
  })

  it('should not crash when agent is unavailable', async function () {
    this.timeout(30_000)

    assertBunSuccess(await runBun('bun/init-agent-unavailable.js'))
  })

  it('should emit app-started telemetry under Bun', async function () {
    this.timeout(30_000)

    const agent = await new FakeAgent().start()

    try {
      const telemetryPromise = agent.assertTelemetryReceived('app-started', 20_000, 1)

      assertBunSuccess(await runBun('bun/init-telemetry.js', {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
      }))
      await telemetryPromise
    } finally {
      await agent.stop()
    }
  })

  it('should auto-instrument basic HTTP traffic', async function () {
    this.timeout(30_000)

    const agent = await new FakeAgent().start()

    try {
      const messagePromise = agent.assertMessageReceived(({ payload }) => {
        assert.ok(Array.isArray(payload), 'Expected trace payload array')
        const spans = payload.flat()
        assert.ok(
          spans.some(span => span.name === 'web.request' || span.name === 'http.request'),
          'Expected web.request or http.request span'
        )
      }, 20_000)

      assertBunSuccess(await runBun('bun/http-instrumentation.js', {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      }))
      await messagePromise
    } finally {
      await agent.stop()
    }
  })
})
