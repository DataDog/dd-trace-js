'use strict'

const proxyquire = require('proxyquire')

function getConfigFresh (options, stubs = {}) {
  const childCountBefore = module.children.length
  const helper = proxyquire.noPreserveCache()('../../src/config/helper.js', {})
  const defaults = proxyquire.noPreserveCache()('../../src/config/defaults.js', {})
  const config = proxyquire.noPreserveCache()('../../src/config', {
    './defaults': defaults,
    './helper': helper,
    ...stubs,
  })(options)
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
