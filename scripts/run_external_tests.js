'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync
const git = require('./helpers/git')
const title = require('./helpers/title')
const executeTest = require('../packages/dd-trace/test/plugins/harness')

// Get the plugin whose external tests we want to run
let plugin
if (process.argv[2]) {
  plugin = process.argv[2]
} else if (process.env.hasOwnProperty('PLUGINS')) {
  plugin = process.env.PLUGINS.split('|')[0]
}

// Make sure it's a valid plugin
const pluginPath = path.join(__dirname, `../packages/datadog-plugin-${plugin}`)
if (!fs.existsSync(pluginPath)) {
  throw new Error(`'${plugin}' is not a valid plugin`)
}

// Get the test configurations from the plugin's external test configuration file
const testConfigsPath = path.join(pluginPath, '/test/external_tests.js')
if (!fs.existsSync(testConfigsPath)) {
  execSync(`echo "'${plugin}' does not support external tests"`, { stdio: [0, 1, 2] })
  process.exit(0)
}

const testConfigs = require(testConfigsPath)
executeTestConfigs(testConfigs)

function executeTestConfigs (testConfigs) {
  let exitCode = 0

  for (let i = 0; i < testConfigs.length; ++i) {
    const testConfig = testConfigs[i]

    // Clean up the config and make sure it's a valid test config
    validateConfig(testConfig)
    cleanupConfig(testConfig)

    // Print out the test config name
    title(testConfig.name)

    // Get the integration
    const executionPath = getIntegration(testConfig)

    // Execute tests through harness
    exitCode = executeTest(testConfig, executionPath) || exitCode
  }

  process.exit(exitCode)
}

function getIntegration (testConfig) {
  // Make a folder for the repos, if it doesn't already exist
  const basePath = path.join(__dirname, '..')

  // Set up the download path for the integration
  const integrationVersionDir = `${testConfig.integration}@${testConfig.branch}`
  const integrationPath = path.join(basePath, 'repos', integrationVersionDir, 'node_modules', testConfig.integration)

  // Clone the repo
  git.clone(testConfig.repo, integrationPath, testConfig.branch, { cwd: basePath })

  return integrationPath
}

function cleanupConfig (testConfig) {
  if (!testConfig.setup) {
    testConfig.setup = (tracerSetupPath, options) => execSync('npm install', options)
  }

  testConfig.branch = testConfig.branch || 'master'
  testConfig.name = testConfig.name || `${testConfig.integration} (${testConfig.branch}) - ${testConfig.framework}`
  testConfig.args = testConfig.args || ''
}

function validateConfig (testConfig) {
  if (!testConfig.integration) {
    throw new Error('All test configurations must have an "integration" field')
  }

  if (!testConfig.repo) {
    throw new Error('All test configurations must have a "repo" field')
  }

  if (!testConfig.framework) {
    throw new Error('All test configurations must have a "framework" field')
  }

  if (testConfig.framework === 'custom' && !testConfig.execTests) {
    throw new Error('All "custom" test configurations must have a "execTests" function')
  }
}
