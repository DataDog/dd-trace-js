'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')

const fixturePath = path.join(__dirname, 'fixtures/jest-worker-init.js')
const initPath = path.resolve(__dirname, '../../../../ci/init.js')

async function isTracerLoadedForWorker (workerPath) {
  const child = fork(fixturePath, {
    env: {
      ...process.env,
      DD_CIVISIBILITY_ENABLED: 'false',
      JEST_WORKER_ID: '1',
    },
    execArgv: ['--require', initPath],
    silent: true,
  })
  const messagePromise = once(child, 'message')
  const exitPromise = once(child, 'exit')
  child.send([0, false, workerPath, []])
  const [[message], [exitCode]] = await Promise.all([messagePromise, exitPromise])
  assert.strictEqual(exitCode, 0)
  return message.tracerLoaded
}

describe('Jest worker initialization', () => {
  it('does not initialize dd-trace in jest-haste-map workers', async () => {
    assert.strictEqual(
      await isTracerLoadedForWorker('/project/node_modules/jest-haste-map/build/worker.js'),
      false
    )
  })

  it('does not initialize dd-trace in coverage workers on Windows', async () => {
    assert.strictEqual(
      await isTracerLoadedForWorker('C:\\project\\node_modules\\@jest\\reporters\\build\\CoverageWorker.js'),
      false
    )
  })

  it('initializes dd-trace in Jest test workers', async () => {
    assert.strictEqual(
      await isTracerLoadedForWorker('/project/node_modules/jest-runner/build/testWorker.js'),
      true
    )
  })

  it('initializes dd-trace in unknown Jest workers', async () => {
    assert.strictEqual(
      await isTracerLoadedForWorker('/project/custom-runner/worker.js'),
      true
    )
  })
})
