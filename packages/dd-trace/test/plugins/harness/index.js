'use strict'

const executeJest = require('./jest')
const executeGeneric = require('./generic')
const executeNodeunit = require('./nodeunit')
const executeTap = require('./tap')
const executeCustom = require('./custom')

function executeTest (testConfig, executionPath) {
  const options = { cwd: executionPath, stdio: [0, 1, 2] }

  // Copy environment variables over
  if (testConfig.testEnv) {
    const envCopy = {}
    Object.keys(process.env).forEach(prop => {
      envCopy[prop] = process.env[prop]
    })

    Object.keys(testConfig.testEnv).forEach(prop => {
      envCopy[prop] = testConfig.testEnv[prop]
    })
    options.env = envCopy
  }

  const testArgs = testConfig.testArgs || ''

  // Run the test framework harness
  switch (testConfig.testType) {
    case 'jest':
      executeJest(testArgs, options)
      break
    case 'lab':
    case 'mocha':
      executeGeneric(testConfig.testType, testArgs, options)
      break
    case 'nodeunit':
      executeNodeunit(testArgs, options)
      break
    case 'tap':
      executeTap(testArgs, options)
      break
    case 'custom':
      executeCustom(testConfig, options)
      break
    default:
      throw new Error(`'${testConfig.testType}' is an unsupported test framework`)
  }
}

module.exports = executeTest
