'use strict'

const proxyquire = require('proxyquire')

function getConfigFresh (options) {
  const helper = proxyquire.noPreserveCache()('../../src/config/helper.js', {})
  const defaults = proxyquire.noPreserveCache()('../../src/config/defaults.js', {})
  return proxyquire.noPreserveCache()('../../src/config', {
    './defaults': defaults,
    './helper': helper,
  })(options)
}

module.exports = {
  getConfigFresh,
}
