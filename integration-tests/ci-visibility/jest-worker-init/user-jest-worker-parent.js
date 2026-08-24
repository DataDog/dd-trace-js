'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { Worker } = require('jest-worker')

async function run () {
  const preloadSource = process.env.JEST_WORKER_PRELOAD_SOURCE
  const forkOptions = preloadSource === 'environment'
    ? { env: {} }
    : preloadSource === 'environment-null' ? { env: null } : { execArgv: [] }
  let workerPath = path.join(__dirname, 'user-jest-worker.js')
  if (preloadSource === 'environment-null') {
    workerPath = path.join(path.dirname(require.resolve('@jest/reporters')), 'dd-test-worker.js')
    fs.copyFileSync(path.join(__dirname, 'user-jest-worker.js'), workerPath)
  }
  const worker = new Worker(workerPath, {
    enableWorkerThreads: true,
    forkOptions,
    numWorkers: 1,
  })

  try {
    process.send(await worker.getState())
  } finally {
    await worker.end()
  }
}

run().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
