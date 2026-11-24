'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const { join } = require('node:path')

const { after, before, describe, it } = require('mocha')

const fixture = join(__dirname, 'fixtures', 'initialization-process.js')
// Far below the default 30s initialization timeout, so a process the provider keeps holding is killed.
const KILL_TIMEOUT_MS = 10_000
const CONFIGURATION_BODY = JSON.stringify({
  data: {
    type: 'universal-flag-configuration',
    attributes: {
      format: 'SERVER',
      createdAt: '2026-01-01T00:00:00.000Z',
      environment: { name: 'test' },
      flags: {},
    },
  },
})

// See https://github.com/DataDog/dd-trace-js/issues/11355.
describe('FlaggingProvider initialization in an otherwise idle process', function () {
  this.timeout(KILL_TIMEOUT_MS * 2)

  /** @type {number} */
  let closedPort
  /** @type {http.Server} */
  let server
  /** @type {number[]} */
  let statusCodes

  before(async () => {
    const closed = http.createServer().listen(0, '127.0.0.1')
    await once(closed, 'listening')
    closedPort = /** @type {import('node:net').AddressInfo} */ (closed.address()).port
    closed.close()
    await once(closed, 'close')

    server = http.createServer((req, res) => {
      const statusCode = statusCodes.shift() ?? 503
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(statusCode === 200 ? CONFIGURATION_BODY : '')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })

  after(() => {
    server.close()
  })

  function agentless (port = closedPort) {
    return {
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: `http://127.0.0.1:${port}`,
      // The shortest poll interval gives the shortest retry delay, about 2s.
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: '1',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
    }
  }

  /**
   * @param {'wait' | 'wait-later' | 'close' | 'idle'} mode
   * @param {Record<string, string>} env
   * @returns {Promise<{ code: number | null, signal: string | null, lines: string[], stderr: string }>}
   */
  function run (mode, env) {
    return new Promise(resolve => {
      execFile(process.execPath, [fixture, mode], {
        env: {
          ...process.env,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: 'true',
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          DD_TRACE_AGENT_PORT: String(closedPort),
          DD_TRACE_STARTUP_LOGS: 'false',
          ...env,
        },
        timeout: KILL_TIMEOUT_MS,
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? /** @type {number | null} */ (error.code) : 0,
          signal: error?.signal ?? null,
          lines: stdout.trim().split('\n'),
          stderr,
        })
      })
    })
  }

  for (const { source, env } of [
    { source: 'an unreachable agentless endpoint', env: () => agentless() },
    {
      source: 'an unreachable agent',
      env: () => ({ DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'remote_config', DD_REMOTE_CONFIGURATION_ENABLED: 'true' }),
    },
  ]) {
    it(`rejects with the initialization timeout instead of exiting with code 0 with ${source}`, async () => {
      const { code, signal, lines, stderr } = await run('wait', {
        ...env(),
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: '1000',
      })

      assert.deepStrictEqual({ code, signal, lines }, {
        code: 1,
        signal: null,
        lines: ['rejected: Initialization timeout after 1000ms', 'exit 1'],
      }, stderr)
    })
  }

  it('rejects with the initialization timeout when initialization starts after a failed poll', async () => {
    const { code, signal, lines, stderr } = await run('wait-later', {
      ...agentless(),
      DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: '1000',
    })

    assert.deepStrictEqual({ code, signal, lines }, {
      code: 1,
      signal: null,
      lines: ['rejected: Initialization timeout after 1000ms', 'exit 1'],
    }, stderr)
  })

  it('keeps retrying until configuration arrives, then lets the process exit', async () => {
    statusCodes = [503, 200]

    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
    const { code, signal, lines, stderr } = await run('wait', agentless(port))

    assert.deepStrictEqual({ code, signal, lines }, { code: 0, signal: null, lines: ['ready', 'exit 0'] }, stderr)
    assert.deepStrictEqual(statusCodes, [])
  })

  for (const mode of /** @type {const} */ (['idle', 'close'])) {
    it(`does not hold a process whose provider is ${mode === 'idle' ? 'never initialized' : 'closed'}`, async () => {
      const { code, signal, lines, stderr } = await run(mode, agentless())

      assert.deepStrictEqual({ code, signal, lines }, { code: 0, signal: null, lines: ['exit 0'] }, stderr)
    })
  }
})
