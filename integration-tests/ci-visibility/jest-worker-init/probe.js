'use strict'

const fs = require('node:fs')
const path = require('node:path')

const outputDirectory = process.env.DD_TEST_JEST_WORKER_OUTPUT
const initPath = require.resolve('dd-trace/ci/init')
const tracerPath = require.resolve(path.join(path.dirname(initPath), '..', 'packages', 'dd-trace'))

function recordWorkerInitialization (message) {
  if (!Array.isArray(message) || message[0] !== 0 || !outputDirectory) return

  // ci/init prepends its handler, so this listener observes the completed tracer-loading decision.
  process.removeListener('message', recordWorkerInitialization)

  const outputPath = path.join(outputDirectory, `${process.pid}.json`)
  fs.writeFileSync(outputPath, JSON.stringify({
    tracerLoaded: require.cache[tracerPath] !== undefined,
    workerPath: message[2],
  }))
}

process.on('message', recordWorkerInitialization)
