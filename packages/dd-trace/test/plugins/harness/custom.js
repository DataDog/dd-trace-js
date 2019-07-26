'use strict'

const path = require('path')

function executeCustom (testConfig, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')
  return testConfig.testFn(tracerSetupPath, options)
}

module.exports = executeCustom
