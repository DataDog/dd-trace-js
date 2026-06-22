'use strict'

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

describe('log capture — agent integration', () => {
  let intake, agent, proc, cwd, appFile

  useSandbox(['express', 'pino', 'winston', 'bunyan'])

  before(async () => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'log-capture-hooks-agent/app.js')
    intake = await startIntake()
  })

  after(async () => {
    await intake.close()
  })

  beforeEach(async function () {
    intake.reset()

    // A FakeAgent absorbs trace payloads so dd-trace has somewhere to send spans.
    agent = await new FakeAgent().start()

    proc = await spawnProc(appFile, {
      cwd,
      env: {
        // Tracing must be enabled so dd-trace instruments pino via ritm.
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

  // ── Pino ──────────────────────────────────────────────────────────────────────
  it('pino: forwards an info log when GET /info is called', async () => {
    await get(`${proc.url}/info`)
    const record = await pollForRecord(intake, r => r.msg === 'pino info route hit')
    // pino uses numeric levels: 30 = info
    assert.strictEqual(record.level, 30)
    assert.strictEqual(record.route, '/info')
  })

  it('pino: forwards a warn log when GET /warn is called', async () => {
    await get(`${proc.url}/warn`)
    const record = await pollForRecord(intake, r => r.msg === 'pino warn route hit')
    // pino: 40 = warn
    assert.strictEqual(record.level, 40)
    assert.strictEqual(record.route, '/warn')
  })

  it('pino: forwards an error log when GET /error is called', async () => {
    await get(`${proc.url}/error`)
    const record = await pollForRecord(intake, r => r.msg === 'pino error route hit')
    // pino: 50 = error
    assert.strictEqual(record.level, 50)
    assert.strictEqual(record.route, '/error')
  })

  // ── Winston ────────────────────────────────────────────────────────────────────
  it('winston: forwards an info log when GET /winston/info is called', async () => {
    await get(`${proc.url}/winston/info`)
    const record = await pollForRecord(intake, r => r.message === 'winston info route hit')
    // winston uses string levels
    assert.strictEqual(record.level, 'info')
    assert.strictEqual(record.route, '/winston/info')
  })

  it('winston: forwards a warn log when GET /winston/warn is called', async () => {
    await get(`${proc.url}/winston/warn`)
    const record = await pollForRecord(intake, r => r.message === 'winston warn route hit')
    assert.strictEqual(record.level, 'warn')
    assert.strictEqual(record.route, '/winston/warn')
  })

  it('winston: forwards an error log when GET /winston/error is called', async () => {
    await get(`${proc.url}/winston/error`)
    const record = await pollForRecord(intake, r => r.message === 'winston error route hit')
    assert.strictEqual(record.level, 'error')
    assert.strictEqual(record.route, '/winston/error')
  })

  // ── Bunyan ─────────────────────────────────────────────────────────────────────
  it('bunyan: forwards an info log when GET /bunyan/info is called', async () => {
    await get(`${proc.url}/bunyan/info`)
    const record = await pollForRecord(intake, r => r.msg === 'bunyan info route hit')
    // bunyan uses numeric levels: 30 = info
    assert.strictEqual(record.level, 30)
    assert.strictEqual(record.route, '/bunyan/info')
  })

  it('bunyan: forwards a warn log when GET /bunyan/warn is called', async () => {
    await get(`${proc.url}/bunyan/warn`)
    const record = await pollForRecord(intake, r => r.msg === 'bunyan warn route hit')
    // bunyan: 40 = warn
    assert.strictEqual(record.level, 40)
    assert.strictEqual(record.route, '/bunyan/warn')
  })

  it('bunyan: forwards an error log when GET /bunyan/error is called', async () => {
    await get(`${proc.url}/bunyan/error`)
    const record = await pollForRecord(intake, r => r.msg === 'bunyan error route hit')
    // bunyan: 50 = error
    assert.strictEqual(record.level, 50)
    assert.strictEqual(record.route, '/bunyan/error')
  })
})
