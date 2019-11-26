'use strict'

function executeCustom (tracerSetupPath, testConfig, options) {
  return testConfig.execTests(tracerSetupPath, options)
}

module.exports = executeCustom
