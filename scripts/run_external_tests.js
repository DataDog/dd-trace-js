'use strict'

const path = require('path')
const fs = require('fs')
const title = require('./helpers/title')
const execSync = require('./helpers/exec')
const git = require('./helpers/git')
const harness = require('../packages/dd-trace/test/plugins/harness')

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

  // Make a folder for the repos, if it doesn't already exist
  const basePath = path.join(__dirname, '..')
  execSync('mkdir -p "repos"', { cwd: basePath })

  // Make a folder for any repos for the integration
  const baseReposPath = path.join(basePath, 'repos')
  execSync(`mkdir -p '${testConfig.integration}'`, { cwd: baseReposPath })

  // Get the repo name from the URL
  const integrationReposPath = path.join(baseReposPath, testConfig.integration)
  git.cloneOrPull(testConfig.repo, { cwd: integrationReposPath })

  // Checkout the branch, if we have to
  const currentRepoPath = path.join(integrationReposPath, git.getRepoName(testConfig.repo))
  if (testConfig.branch) {
    git.checkout(testConfig.branch, { cwd: currentRepoPath })
  } else {
    git.checkoutDefault({ cwd: currentRepoPath })
  }

  // Execute mocha with setup code
  switch (testConfig.testType) {
    case 'mocha':
      harness.executeMocha(testConfig.testArgs, { cwd: currentRepoPath })
      break
    default:
      throw new Error(`'${testConfig.testType}' is an unsupported test framework`)
  }
}

function normalizeConfig (defaultConfig, testConfig) {
  if (!defaultConfig.integration && !testConfig.integration) {
    throw new Error('All test configurations must have an "integration" field')
  }

  if (!defaultConfig.repo && !testConfig.repo) {
    throw new Error('All test configurations must have a "repo" field')
  }

  if (!defaultConfig.testType && !testConfig.testType) {
    throw new Error('All test configurations must have an "testType" field')
  }

  const config = {
    integration: testConfig.integration || defaultConfig.integration,
    repo: testConfig.repo || defaultConfig.repo,
    branch: testConfig.branch || defaultConfig.branch,
    testType: testConfig.testType || defaultConfig.testType,
    testArgs: testConfig.testArgs || defaultConfig.testArgs
  }

  config.name = config.branch ? `${config.integration} (${config.branch})` : config.integration

  return config
}
