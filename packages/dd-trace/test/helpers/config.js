'use strict'

const proxyquire = require('proxyquire')

function getConfigFresh (options, stubs = {}) {
  const childCountBefore = module.children.length
  const loadHelper = proxyquire.noPreserveCache()
  const helper = loadHelper('../../src/config/helper.js', {})
  const loadDefaults = proxyquire.noPreserveCache()
  const defaults = loadDefaults('../../src/config/defaults.js', {})
  const loadConfig = proxyquire.noPreserveCache()
  const createConfig = loadConfig('../../src/config', {
    './defaults': defaults,
    './helper': helper,
    ...stubs,
  })
  const config = createConfig(options)
  // proxyquire links every freshly loaded module into this module's `children`;
  // `noPreserveCache` clears `require.cache` but not that array, so each
  // re-instrumented config graph stays pinned for the process lifetime. Detaching
  // them lets the fresh graph collect once the returned config is dropped.
  module.children.length = childCountBefore
  return config
}

module.exports = {
  getConfigFresh,
}
