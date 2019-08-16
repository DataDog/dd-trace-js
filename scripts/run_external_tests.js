'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync
const git = require('./helpers/git')
const title = require('./helpers/title')
const executeTest = require('../packages/dd-trace/test/plugins/harness')

// Get the plugin whose external tests we want to run
const plugin = process.argv[2]

// Make sure it's a valid plugin
const testConfigPath = path.join(__dirname, `../packages/datadog-plugin-${plugin}/test/external_tests.js`)
if (!fs.existsSync(testConfigPath)) {
  throw new Error(`'${plugin}' is not a valid plugin or it does not support external tests`)
}

// Get the test configurations from the plugin's external test configuration file
const testConfigs = require(`../packages/datadog-plugin-${plugin}/test/external_tests.js`)

executeTestConfigs(testConfigs)

function executeTestConfigs (testConfigs) {
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
    executeTest(testConfig, executionPath)
  }
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
    testConfig.setup = (cwd) => execSync('npm install', { cwd })
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
