'use strict'

const path = require('node:path')
const { parentPort } = require('node:worker_threads')

const initPath = require.resolve('dd-trace/ci/init')
const tracerPath = require.resolve(path.join(path.dirname(initPath), '..', 'packages', 'dd-trace'))

parentPort.postMessage({
  hasJestWorkerThreadArgument: process.argv.includes('--dd-test-optimization-jest-worker-thread'),
  tracerLoaded: require.cache[tracerPath] !== undefined,
})
