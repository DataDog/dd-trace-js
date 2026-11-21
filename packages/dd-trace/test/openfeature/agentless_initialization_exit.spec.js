'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { once } = require('node:events')
const { createServer } = require('node:net')
const { join } = require('node:path')

const { describe, it } = require('mocha')

const fixture = join(__dirname, 'fixtures', 'unreachable-agentless-endpoint.js')

// The shortest first retry delay, 2000ms minus 20% jitter: a process that exits sooner did not wait for a retry.
const FIRST_RETRY_MIN_MS = 1600

/**
 * Returns a local port that refuses connections.
 */
async function closedPort () {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  server.close()
  await once(server, 'close')
  return port
}

/**
 * @param {'wait' | 'never-initialize'} mode
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
async function run (mode) {
  const port = await closedPort()
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [fixture, mode], {
      env: {
        ...process.env,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'true',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: `http://127.0.0.1:${port}`,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: '1',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        DD_TRACE_STARTUP_LOGS: 'false',
      },
      timeout: 20_000,
    }, (error, stdout, stderr) => {
      if (error && error.code === undefined) return reject(error)
      resolve({ code: child.exitCode, stdout, stderr })
    })
  })
}

// See https://github.com/DataDog/dd-trace-js/issues/11355.
describe('OpenFeature agentless initialization in an otherwise idle process', () => {
  it('rejects initialization with the poll error instead of exiting with code 0', async function () {
    this.timeout(30_000)

    const { code, stdout, stderr } = await run('wait')

    const [outcome, exit] = stdout.trim().split('\n')
    assert.match(
      outcome,
      /^rejected: Feature Flagging agentless configuration poll failed \(retries exhausted: connect ECONNREFUSED /
    )
    assert.strictEqual(JSON.parse(exit).code, 1)
    assert.strictEqual(code, 1, stderr)
  })

  it('does not hold a process that never initializes the provider', async function () {
    this.timeout(30_000)

    const { code, stdout, stderr } = await run('never-initialize')

    const { code: exitCode, elapsedMs } = JSON.parse(stdout.trim())
    assert.strictEqual(exitCode, 0)
    assert.strictEqual(code, 0, stderr)
    assert.ok(elapsedMs < FIRST_RETRY_MIN_MS, `exited after ${elapsedMs}ms`)
  })
})
