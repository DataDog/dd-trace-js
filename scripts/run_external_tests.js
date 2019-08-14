'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync
const git = require('./helpers/git')
const title = require('./helpers/title')
const executeTest = require('../packages/dd-trace/test/plugins/harness')
const coalesce = require('koalas')

// Get the plugin whose external tests we want to run
const plugin = process.argv[2]

// Make sure it's a valid plugin
const testConfigPath = path.join(__dirname, `../packages/datadog-plugin-${plugin}/test/external_tests.js`)
if (!fs.existsSync(testConfigPath)) {
  throw new Error(`'${plugin}' is not a valid plugin or it does not support external tests`)
}

// Get the test configurations from the plugin's external test configuration file
const { testConfigs, defaultConfig } = require(`../packages/datadog-plugin-${plugin}/test/external_tests.js`)

executeTestConfigs(testConfigs, defaultConfig)

function executeTestConfigs (testConfigs, defaultConfig) {
  if (!testConfigs) {
    testConfigs = [{}]
  } else {
    if (Array.isArray(testConfigs)) {
      if (testConfigs.length === 0) {
        testConfigs = [{}]
      }
    } else {
      testConfigs = [testConfigs]
    }
  }

  for (let i = 0; i < testConfigs.length; ++i) {
    // Normalize the test config
    const testConfig = normalizeConfig(testConfigs[i], defaultConfig)

    // Print out the test config name
    title(testConfig.name)

    // Get the integration
    const executionPath = grabIntegration(testConfig)

    // Execute tests through harness
    executeTest(testConfig, executionPath)
  }
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

function normalizeConfig (testConfig, defaultConfig) {
  const config = {
    integration: coalesce(testConfig.integration, defaultConfig.integration),
    repo: coalesce(testConfig.repo, defaultConfig.repo),
    branch: coalesce(testConfig.branch, defaultConfig.branch),
    testType: coalesce(testConfig.testType, defaultConfig.testType),
    testEnv: coalesce(testConfig.testEnv, defaultConfig.testEnv),
    localCwd: coalesce(testConfig.localCwd, defaultConfig.localCwd),
    setup: coalesce(testConfig.setup, defaultConfig.setup)
  }

  if (!config.setup) {
    config.setup = (cwd) => execSync('npm install', { cwd })
  }

  config.name = coalesce(testConfig.name, defaultConfig.name)
  if (!config.name) {
    config.name = `${config.integration} (${config.branch || 'default branch'}) - ${config.testType}`
  }

  if (config.testType === 'custom') {
    config.testFn = coalesce(testConfig.testFn, defaultConfig.testFn)
  } else {
    config.testArgs = coalesce(testConfig.testArgs, defaultConfig.testArgs, '')
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
    throw new Error('All "custom" test configurations must have a "testFn" function')
  }

  return config
}
