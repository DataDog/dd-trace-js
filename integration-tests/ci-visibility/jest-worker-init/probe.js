'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, threadId } = require('node:worker_threads')

const outputDirectory = process.env.DD_TEST_JEST_WORKER_OUTPUT
const initPath = require.resolve('dd-trace/ci/init')
const tracerPath = require.resolve(path.join(path.dirname(initPath), '..', 'packages', 'dd-trace'))
const messagePort = process.send ? process : parentPort

function recordWorkerInitialization (message) {
  if (!Array.isArray(message) || message[0] !== 0 || !outputDirectory) return

  messagePort.removeListener('message', recordWorkerInitialization)
  queueMicrotask(() => {
    const outputPath = path.join(outputDirectory, `${process.pid}-${threadId}.json`)
    fs.writeFileSync(outputPath, JSON.stringify({
      threadId,
      tracerLoaded: require.cache[tracerPath] !== undefined,
      workerPath: message[2],
    }))
  })
}

if (outputDirectory && messagePort) {
  messagePort.on('message', recordWorkerInitialization)
}
