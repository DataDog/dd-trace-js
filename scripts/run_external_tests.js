'use strict'

const path = require('path')
const fs = require('fs')
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
const externalTestConfigs = require(`../packages/datadog-plugin-${plugin}/test/external_tests.js`)
const defaultConfig = externalTestConfigs.defaultConfig
let testConfigs = externalTestConfigs.testConfigs
if (Array.isArray(testConfigs)) {
  if (testConfigs.length === 0) {
    testConfigs = [{}]
  }
} else {
  testConfigs = [testConfigs]
}

for (let i = 0; i < testConfigs.length; ++i) {
  const testConfig = normalizeConfig(defaultConfig, testConfigs[i])

  // Print out the test config name
  title(testConfig.name)

  // Get the integration
  const executionPath = grabIntegration(testConfig)

  // Execute tests through harness
  executeTest(testConfig, executionPath)
}

function grabIntegration (testConfig) {
  // Make a folder for the repos, if it doesn't already exist
  const basePath = path.join(__dirname, '..')

  // Set up the download path for the integration
  let integrationVersionPath
  if (testConfig.branch) {
    integrationVersionPath = `${testConfig.integration}@${testConfig.branch}`
  } else {
    integrationVersionPath = testConfig.integration
  }

  const integrationPath = path.join(basePath, 'repos', integrationVersionPath, 'node_modules', testConfig.integration)

  // Clone the repo
  git.cloneWithBranch(testConfig.repo, integrationPath, testConfig.branch, { cwd: basePath })

  // Execute the setup function, if it exists
  if (testConfig.setup) {
    testConfig.setup(integrationPath)
  }

  return testConfig.localCwd ? path.join(integrationPath, testConfig.localCwd) : integrationPath
}

function normalizeConfig (defaultConfig, testConfig) {
  const config = {
    integration: testConfig.integration || defaultConfig.integration,
    repo: testConfig.repo || defaultConfig.repo,
    branch: testConfig.branch || defaultConfig.branch,
    testType: testConfig.testType || defaultConfig.testType,
    localCwd: testConfig.localCwd || defaultConfig.localCwd,
    setup: testConfig.setup || defaultConfig.setup
  }

  config.name = testConfig.name || defaultConfig.name ||
    config.branch ? `${config.integration} (${config.branch})` : config.integration

  if (config.testType === 'custom') {
    config.testFn = testConfig.testFn || defaultConfig.testFn
  } else {
    config.testArgs = testConfig.testArgs || defaultConfig.testArgs || ''
  }

  if (!config.integration) {
    throw new Error('All test configurations must have an "integration" field')
  }

  if (!config.repo) {
    throw new Error('All test configurations must have a "repo" field')
  }

  if (!config.testType) {
    throw new Error('All test configurations must have a "testType" field')
  }

  if (config.testType === 'custom' && !config.testFn) {
    throw new Error('All "custom" test configurations must have a "testFn" field')
  }

  return config
}
