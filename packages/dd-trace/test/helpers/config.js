'use strict'

const proxyquire = require('proxyquire')

// Resolve the config module from within the test package
const CONFIG_PATH = require.resolve('../../src/config')

function getConfigFresh (options) {
  return proxyquire.noPreserveCache()(CONFIG_PATH, {})(options)
}

module.exports = {
  getConfigFresh,
}
