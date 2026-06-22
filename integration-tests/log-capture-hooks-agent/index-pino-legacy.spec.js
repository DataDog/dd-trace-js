'use strict'

// Tests the log capture path for pino < 5.14.0, where dd-trace wraps `asJson`
// directly via the same `wrapAsJson` hook used for all pino versions.
// The completed JSON line is published on the apm:pino:log:json channel.
// See: packages/datadog-instrumentations/src/pino.js (hooks for '2 - 3', '4',
// and '>=5 <5.14.0').

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { useSandbox, sandboxCwd, FakeAgent, spawnProc, stopProc } = require('../helpers')
const { start: startIntake } = require('./mock-intake')

/**
 * Poll `intake.records` until `predicate` returns a matching record or `timeoutMs` elapses.
 * @param {{ records: object[] }} intake
 * @param {(r: object) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
function pollForRecord (intake, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const found = intake.records.find(predicate)
      if (found) return resolve(found)
      if (Date.now() >= deadline) {
        return reject(new Error(
          `No matching record within ${timeoutMs} ms. Records: ${JSON.stringify(intake.records)}`
        ))
      }
      setTimeout(check, 50)
    }
    check()
  })
}

/** Fire-and-forget HTTP GET to the app. */
function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      res.resume()
      res.once('end', resolve)
      res.once('error', reject)
    }).once('error', reject)
  })
}

describe('log capture — pino legacy (< 5.14.0) integration', () => {
  let intake, agent, proc, cwd, appFile

  // Install the last pino version that uses the pre-mixin symbol path.
  // The sandbox installs this specific range regardless of package.json.
  useSandbox(['express', 'pino@>=5 <5.14.0'])

  before(async () => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'log-capture-hooks-agent/app-pino-legacy.js')
    intake = await startIntake()
  })

  after(async () => {
    await intake.close()
  })

  beforeEach(async function () {
    intake.reset()

    agent = await new FakeAgent().start()

    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_ENABLED: 'true',
        DD_TRACE_AGENT_PORT: String(agent.port),
        DD_LOG_CAPTURE_ENABLED: 'true',
        DD_LOG_CAPTURE_HOST: '127.0.0.1',
        DD_LOG_CAPTURE_PORT: String(intake.port),
        DD_LOG_CAPTURE_FLUSH_INTERVAL_MS: '100',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_LOGS_INJECTION: 'true',
        DD_SERVICE: 'log-capture-test',
        DD_ENV: 'test',
      },
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('forwards an info log when GET /info is called', async () => {
    await get(`${proc.url}/info`)
    const record = await pollForRecord(intake, r => r.msg === 'pino info route hit')
    // pino uses numeric levels: 30 = info
    assert.strictEqual(record.level, 30)
    assert.strictEqual(record.route, '/info')
  })

  it('forwards a warn log when GET /warn is called', async () => {
    await get(`${proc.url}/warn`)
    const record = await pollForRecord(intake, r => r.msg === 'pino warn route hit')
    // pino: 40 = warn
    assert.strictEqual(record.level, 40)
    assert.strictEqual(record.route, '/warn')
  })

  it('forwards an error log when GET /error is called', async () => {
    await get(`${proc.url}/error`)
    const record = await pollForRecord(intake, r => r.msg === 'pino error route hit')
    // pino: 50 = error
    assert.strictEqual(record.level, 50)
    assert.strictEqual(record.route, '/error')
  })
})
