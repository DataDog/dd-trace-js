'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getCiVisAgentlessConfig, sandboxCwd, useSandbox } = require('../helpers')

const JEST_VERSION = process.env.JEST_VERSION || '30.0.5'
const responseDelayMs = Number(process.env.DD_REPRO_RESPONSE_DELAY_MS || 3_000)

describe(`jest@${JEST_VERSION} sequential runCLI request pressure reproduction`, () => {
  let childProcess
  let receiver
  let cwd

  useSandbox([`jest@${JEST_VERSION}`], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    receiver = new FakeCiVisIntake()
    await receiver.start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver.stop()
  })

  it('measures test-cycle payload concurrency and final-flush delivery', async function () {
    this.timeout(Number(process.env.DD_REPRO_TIMEOUT_MS || 120_000))

    receiver.setSettings({
      code_coverage: false,
      early_flake_detection: { enabled: false },
      itr_enabled: false,
      known_tests_enabled: false,
      require_git: false,
      test_management: { enabled: false },
      tests_skipping: false,
    })
    receiver.setWaitingTime(responseDelayMs)

    const intakeStatistics = {
      active: 0,
      bytesStarted: 0,
      completed: 0,
      eventsCompleted: 0,
      maxActive: 0,
      payloadsCompleted: 0,
      started: 0,
    }

    receiver.server.on('request', (request, response) => {
      if (!request.url.endsWith('/api/v2/citestcycle')) return

      intakeStatistics.active++
      intakeStatistics.bytesStarted += Number(request.headers['content-length'] || 0)
      intakeStatistics.started++
      intakeStatistics.maxActive = Math.max(intakeStatistics.maxActive, intakeStatistics.active)

      let finished = false
      const finish = () => {
        if (finished) return

        finished = true
        intakeStatistics.active--
        if (response.writableEnded) intakeStatistics.completed++
      }

      response.once('finish', finish)
      response.once('close', finish)
    })
    receiver.on('message', ({ payload, url }) => {
      if (!url.endsWith('/api/v2/citestcycle')) return

      intakeStatistics.payloadsCompleted++
      intakeStatistics.eventsCompleted += payload.events.length
    })

    let output = ''
    childProcess = exec(
      'node ./ci-visibility/run-jest-request-pressure.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_ENABLE_LAGE_PACKAGE_NAME: 'true',
          DD_REPRO_FINAL_TIMEOUT_MS: process.env.DD_REPRO_FINAL_TIMEOUT_MS || '105000',
          DD_REPRO_PARAMETER_BYTES: process.env.DD_REPRO_PARAMETER_BYTES || '6000',
          DD_REPRO_PAYLOAD_SOURCE: process.env.DD_REPRO_PAYLOAD_SOURCE || 'name',
          DD_REPRO_RUN_COUNT: process.env.DD_REPRO_RUN_COUNT || '2',
          DD_REPRO_TEST_COUNT: process.env.DD_REPRO_TEST_COUNT || '2000',
          DD_TRACE_DEBUG: '1',
          DD_TRACE_LOG_LEVEL: 'warn',
        },
      }
    )
    childProcess.stdout.on('data', (chunk) => { output += chunk.toString() })
    childProcess.stderr.on('data', (chunk) => { output += chunk.toString() })

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      once(childProcess.stdout, 'end'),
      once(childProcess.stderr, 'end'),
    ])
    const finalLine = output.split('\n').find(line => line.startsWith('DD_REPRO_FINAL '))

    assert.strictEqual(exitCode, 0, output)
    assert.ok(finalLine, output)

    const clientStatistics = JSON.parse(finalLine.slice('DD_REPRO_FINAL '.length))

    assert.ok(clientStatistics.attempts > 1, output)
    assert.ok(clientStatistics.maxActiveSockets <= clientStatistics.maxSockets, output)
    if (clientStatistics.maxSockets === 1) {
      assert.strictEqual(clientStatistics.maxActiveSockets, 1, output)
      assert.ok(clientStatistics.maxQueuedRequests > 0, output)
    } else {
      assert.ok(clientStatistics.maxActiveSockets > 1, output)
      assert.deepStrictEqual(clientStatistics.errors, {}, output)
      assert.strictEqual(clientStatistics.responses, clientStatistics.attempts, output)
    }

    // This is a manual comparison harness: keep the complete evidence in the command output.
    process.stdout.write(`DD_REPRO_INTAKE ${JSON.stringify(intakeStatistics)}\n`)
    process.stdout.write(`${output.trim()}\n`)
  })
})
