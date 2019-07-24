'use strict'

const execSync = require('child_process').execSync
const executeMocha = require('./mocha')

function executeTest (testConfig, integrationPath) {
  // Execute pretest command, if any
  if (testConfig.pretestCmd) {
    execSync(testConfig.pretestCmd, { cwd: integrationPath })
  }

  // Run the test framework harness
  switch (testConfig.testType) {
    case 'mocha':
      executeMocha(testConfig.testArgs, { cwd: integrationPath })
      break
    default:
      throw new Error(`'${testConfig.testType}' is an unsupported test framework`)
  }
}

module.exports = executeTest
