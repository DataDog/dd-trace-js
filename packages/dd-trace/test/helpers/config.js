'use strict'

const proxyquire = require('proxyquire')
const { resetConfigEnvSources } = require('../../src/config-env-sources')

// Resolve the config module from within the test package
const CONFIG_PATH = require.resolve('../../src/config')

function getConfigFresh (options) {
  // Reset ConfigEnvSources to ensure the config reads current environment variables
  resetConfigEnvSources()
  return proxyquire.noPreserveCache()(CONFIG_PATH, {})(options)
}

module.exports = {
  getConfigFresh,
}
