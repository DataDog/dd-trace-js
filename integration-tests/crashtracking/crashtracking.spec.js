'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')

const { FakeAgent } = require('../helpers')

const describeNotWindows = os.platform() !== 'win32' ? describe : describe.skip

/**
 * Spawn a fixture process that will crash. We don't use spawnProc here because it rejects when the
 * child exits with a non-zero code or a signal, but the crashing processes are expected to do that
 *
 * @param {string} fixture
 * @param {number} agentPort
 * @returns {{ proc: ChildProcess, exitPromise: Promise<void> }}
 */
function spawnCrashFixture (fixture, agentPort) {
  const proc = fork(path.join(__dirname, fixture), [], {
    stdio: 'pipe',
    env: {
      ...process.env,
      DD_TRACE_AGENT_PORT: String(agentPort),
      DD_TRACE_STARTUP_LOGS: 'false',
    },
  })

  const exitPromise = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }))
  })

  return { proc, exitPromise }
}

/**
 * Subscribe to crash telemetry on the fake agent and return a promise that resolves once both
 * the ping (DEBUG) and the full report (ERROR) have arrived.
 *
 * We need to
 *  - start the crashing program
 *  - attach a listener to the fake agent to collect incoming telemetry
 * This can be a source of a race and made the test flaky because the program could
 * crash and emit telemetry before the listener attaches
 *
 * So, we register the listener synchronously before starting the crashing program.
 * @param {FakeAgent} agent
 * @param {number} [timeout]
 * @returns {Promise<{ping: object, report: object}>}
 */
function collectCrashLogs (agent, timeout = 10_000) {
  let ping
  let report

  return new Promise((resolve, reject) => {
    const onTelemetry = ({ payload }) => {
      if (payload.request_type !== 'logs') return

      for (const log of payload.payload.logs) {
        let msg
        try {
          msg = JSON.parse(log.message)
        } catch {
          continue
        }

        if (log.level === 'DEBUG') {
          ping = msg
        } else if (log.level === 'ERROR') {
          report = msg
        }

        if (ping && report) {
          cleanup()
          resolve({ ping, report })
          return
        }
      }
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timeout waiting for crash telemetry'))
    }, timeout)

    function cleanup () {
      clearTimeout(timer)
      agent.removeListener('telemetry', onTelemetry)
    }

    agent.on('telemetry', onTelemetry)
  })
}

describeNotWindows('crashtracking integration', () => {
  let agent

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await agent.stop()
  })

  describe('unix signal crash', () => {
    it('sends a crash report and a ping with a native stack to the telemetry endpoint', async () => {
      const logsPromise = collectCrashLogs(agent)
      const { exitPromise } = spawnCrashFixture('signal-crash.js', agent.port)

      const [{ ping, report }] = await Promise.all([logsPromise, exitPromise])

      // Ping
      assert.strictEqual(ping.kind, 'UnixSignal')
      assert.ok(ping.message.includes('SIGABRT'))

      // Full report
      assert.strictEqual(report.error.kind, 'UnixSignal')
      assert.ok(report.error.message.includes('SIGABRT'))
      assert.strictEqual(report.error.source_type, 'Crashtracking')

      // Stack frames
      const { frames } = report.error.stack
      assert.ok(frames.length > 0, 'expected at least one stack frame')

      // The crashing frame is the call to kill at the top.
      const topFrame = frames[0]
      assert.ok(
        topFrame.function && topFrame.function.toLowerCase().includes('kill'),
        `expected top frame to be the kill syscall, got: ${JSON.stringify(topFrame)}`
      )
    })
  })

  describe('uncaught exception', () => {
    it('sends a crash report and a ping with a JS stack to the telemetry endpoint', async () => {
      const logsPromise = collectCrashLogs(agent)
      const { exitPromise } = spawnCrashFixture('uncaught-exception.js', agent.port)

      const [{ ping, report }] = await Promise.all([logsPromise, exitPromise])

      // Ping
      assert.strictEqual(ping.kind, 'UnhandledException')

      // Full report
      assert.strictEqual(report.error.kind, 'UnhandledException')
      assert.ok(report.error.message.includes('TypeError'))
      assert.ok(report.error.message.includes('integration test uncaught exception'))
      assert.strictEqual(report.error.source_type, 'Crashtracking')

      // Stack frames JS frames carry file/line/column/function
      const { frames } = report.error.stack
      assert.ok(frames.length > 0, 'expected at least one stack frame')

      // The top frame is the throw site of the error in uncaught-exception.js
      const throwFrame = frames[0]
      assert.ok(
        throwFrame.file.includes('uncaught-exception.js'),
        `expected top frame to be uncaught-exception.js, got: ${JSON.stringify(throwFrame)}`
      )
      assert.ok(typeof throwFrame.line === 'number', 'expected line number in top frame')
      assert.ok(typeof throwFrame.column === 'number', 'expected column number in top frame')
    })
  })
})
