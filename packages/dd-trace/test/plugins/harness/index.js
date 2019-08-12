'use strict'

const executeJest = require('./jest')
const executeGeneric = require('./generic')
const executeNode = require('./node')
const executeNodeunit = require('./nodeunit')
const executeTap = require('./tap')
const executeTape = require('./tape')
const executeCustom = require('./custom')

function executeTest (testConfig, executionPath) {
  const options = { cwd: executionPath, stdio: [0, 1, 2] }

  // Merge process env vars with test config's env vars
  if (testConfig.testEnv) {
    options.env = {}
    Object.keys(process.env).forEach(prop => {
      options.env[prop] = process.env[prop]
    })

    Object.keys(testConfig.testEnv).forEach(prop => {
      options.env[prop] = testConfig.testEnv[prop]
    })
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
    case 'buster-test':
    case 'promises-aplus-tests':
    case 'jasmine-node':
      executeNode(testConfig.testType, testArgs, options)
      break
    case 'nodeunit':
      executeNodeunit(testArgs, options)
      break
    case 'tap':
      executeTap(testArgs, options)
      break
    case 'tape':
      executeTape(testArgs, options)
      break
    case 'custom':
      executeCustom(testConfig, options)
      break
    default:
      throw new Error(`'${testConfig.testType}' is an unsupported test framework`)
  }
}

module.exports = executeTest
