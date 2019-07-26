'use strict'

const executeMocha = require('./mocha')
const executeLab = require('./lab')
const executeCustom = require('./custom')

function executeTest (testConfig, executionPath) {
  const options = { cwd: executionPath }

  // Run the test framework harness
  switch (testConfig.testType) {
    case 'mocha':
      executeMocha(testConfig.testArgs, options)
      break
    case 'lab':
      executeLab(testConfig.testArgs, options)
      break
    case 'custom':
      executeCustom(testConfig, options)
      break
    default:
      throw new Error(`'${testConfig.testType}' is an unsupported test framework`)
  }
}

module.exports = executeTest
