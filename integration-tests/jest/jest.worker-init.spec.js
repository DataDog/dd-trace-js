'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const { sandboxCwd, useSandbox } = require('../helpers')
const { DD_MAJOR } = require('../../version')

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const oldestJestVersion = DD_MAJOR >= 6 ? '28.0.0' : '24.8.0'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion

function getPackageName (workerPath) {
  let directory = path.dirname(workerPath)
  while (directory !== path.dirname(directory)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name
    } catch {
      directory = path.dirname(directory)
    }
  }
}

describe(`jest@${JEST_VERSION} worker initialization`, () => {
  let childProcess

  useSandbox([`jest@${JEST_VERSION}`])

  afterEach(() => {
    childProcess?.kill()
  })

  it('does not load the tracer in auxiliary Jest workers', async function () {
    this.timeout(60_000)

    const cwd = sandboxCwd()
    const outputDirectory = path.join(cwd, 'jest-worker-init-output')
    const probePath = path.join(cwd, 'ci-visibility/jest-worker-init/probe.js')
    const runJestPath = path.join(cwd, 'ci-visibility/run-jest.js')
    fs.mkdirSync(outputDirectory)

    let testOutput = ''
    childProcess = fork(runJestPath, {
      cwd,
      env: {
        ...process.env,
        COLLECT_COVERAGE_FROM: 'ci-visibility/jest-worker-init/untested.js',
        COVERAGE_REPORTERS: 'json-summary',
        DD_CIVISIBILITY_ENABLED: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_TEST_JEST_WORKER_OUTPUT: outputDirectory,
        ENABLE_CODE_COVERAGE: '1',
        MAX_WORKERS: '2',
        NODE_OPTIONS: `-r ${probePath} -r dd-trace/ci/init`,
        RUN_IN_PARALLEL: '1',
        TESTS_TO_RUN: 'ci-visibility/jest-worker-init/test-',
      },
      silent: true,
    })
    childProcess.stdout.on('data', chunk => { testOutput += chunk })
    childProcess.stderr.on('data', chunk => { testOutput += chunk })

    const exitPromise = once(childProcess, 'exit')
    const [message] = await once(childProcess, 'message')
    assert.strictEqual(message, 'finished', testOutput)
    childProcess.kill()
    await exitPromise

    const workerRecords = fs.readdirSync(outputDirectory).map(filename => {
      const record = JSON.parse(fs.readFileSync(path.join(outputDirectory, filename), 'utf8'))
      return { ...record, packageName: getPackageName(record.workerPath) }
    })
    const testWorkers = workerRecords.filter(({ packageName }) => packageName === 'jest-runner')
    const hasteWorkers = workerRecords.filter(({ packageName }) => packageName === 'jest-haste-map')
    const coverageWorkers = workerRecords.filter(({ packageName }) => packageName === '@jest/reporters')

    assert.ok(testWorkers.length > 0, `Jest did not create a test worker:\n${testOutput}`)
    assert.ok(hasteWorkers.length > 0, `Jest did not create a haste-map worker:\n${testOutput}`)
    assert.ok(coverageWorkers.length > 0, `Jest did not create a coverage worker:\n${testOutput}`)
    assert.ok(testWorkers.every(({ tracerLoaded }) => tracerLoaded))
    assert.ok(hasteWorkers.every(({ tracerLoaded }) => !tracerLoaded))
    assert.ok(coverageWorkers.every(({ tracerLoaded }) => !tracerLoaded))
  })
})
