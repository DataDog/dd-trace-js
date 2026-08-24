'use strict'

const path = require('node:path')

const initPath = require.resolve('dd-trace/ci/init')
const tracerPath = require.resolve(path.join(path.dirname(initPath), '..', 'packages', 'dd-trace'))

function getState () {
  return {
    tracerLoaded: require.cache[tracerPath] !== undefined,
    workerArguments: process.argv,
  }
}

module.exports = { getState }
