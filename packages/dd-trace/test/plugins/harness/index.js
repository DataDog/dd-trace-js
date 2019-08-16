'use strict'

const path = require('path')
const executeTap = require('./tap')
const executeTape = require('./tape')
const executeNode = require('./node')
const executeCustom = require('./custom')
const executeGeneric = require('./generic')
const executeBinary = require('./binary')

function executeTest (testConfig, executionPath) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')
  const args = testConfig.args || ''
  const options = { cwd: executionPath, stdio: [0, 1, 2] }

  // Merge process env vars with test config's env vars
  if (testConfig.env) {
    options.env = getEnvVars(testConfig)
  }

  // Execute the setup function
  if (testConfig.setup) {
    testConfig.setup(tracerSetupPath, options)
  }

  // Run the test framework harness
  switch (testConfig.framework) {
    case 'tap':
      executeTap(tracerSetupPath, args, options)
      break
    case 'tape':
      executeTape(tracerSetupPath, args, options)
      break
    case 'node':
      executeNode(tracerSetupPath, args, options)
      break
    case 'custom':
      executeCustom(tracerSetupPath, testConfig, options)
      break
    case 'lab':
    case 'mocha':
      executeGeneric(testConfig.framework, tracerSetupPath, args, options)
      break
    case 'buster-test':
    case 'jasmine-node':
    case 'nodeunit':
    case 'promises-aplus-tests':
      executeBinary(testConfig.framework, tracerSetupPath, args, options)
      break
    default:
      throw new Error(`'${testConfig.framework}' is an unsupported test framework`)
  }
}

function getEnvVars (testConfig) {
  const env = {}
  Object.keys(process.env).forEach(prop => {
    env[prop] = process.env[prop]
  })

  Object.keys(testConfig.env).forEach(prop => {
    env[prop] = testConfig.env[prop]
  })

  return env
}

module.exports = executeTest
