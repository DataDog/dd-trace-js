'use strict'

const path = require('node:path')

const { Worker } = require('jest-worker')

async function run () {
  const forkOptions = process.env.JEST_WORKER_PRELOAD_SOURCE === 'environment'
    ? { env: {} }
    : { execArgv: [] }
  const worker = new Worker(path.join(__dirname, 'user-jest-worker.js'), {
    enableWorkerThreads: true,
    forkOptions,
    numWorkers: 1,
  })

  try {
    process.send(await worker.getArguments())
  } finally {
    await worker.end()
  }
}

run().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
