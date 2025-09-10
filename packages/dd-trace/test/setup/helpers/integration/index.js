'use strict'

// Integration test helpers - main entry point

const { createTestSuite } = require('./base-test-scaffolder')
const { IntegrationTestHelper } = require('./integration-class-test-scaffolders/base-integration-helper')
const { WebServerTestHelper } = require('./integration-class-test-scaffolders/web-server-helper')
const { DatabaseTestHelper } = require('./integration-class-test-scaffolders/database-helper')
const { MessagingTestHelper } = require('./integration-class-test-scaffolders/messaging-helper')

function createWebServerTestSuite (pluginName, packageName, TestSetupClass, testCallback, options = {}) {
  return createTestSuite(pluginName, packageName, TestSetupClass, (helper) => {
    // First, generate standard web server test cases
    const webServerHelper = new WebServerTestHelper(pluginName, packageName, TestSetupClass)
    webServerHelper.generateTestCases(helper)

    // Then run custom test cases
    if (testCallback) {
      testCallback(helper)
    }
  }, {
    additionalPlugins: ['http'],
    testAgentOptions: { host: 'localhost', port: 9126 },
    validateTestSetup: (testSetup, pluginName) => {
      const required = ['makeSuccessfulRequest', 'makeErrorRequest']
      const missing = required.filter(method => typeof testSetup[method] !== 'function')
      if (missing.length > 0) throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    },
    ...options
  })
}

function createMessagingTestSuite (pluginName, packageName, TestSetupClass, testCallback, options = {}) {
  return createTestSuite(pluginName, packageName, TestSetupClass, (helper) => {
    // First, generate standard messaging test cases
    const messagingHelper = new MessagingTestHelper(pluginName, packageName, TestSetupClass)
    messagingHelper.generateTestCases(helper)

    // Then run custom test cases
    if (testCallback) {
      testCallback(helper)
    }
  }, {
    testAgentOptions: { host: 'localhost', port: 9126 },
    validateTestSetup: (testSetup, pluginName) => {
      const required = ['addJob', 'waitForJobCompletion']
      const missing = required.filter(method => typeof testSetup[method] !== 'function')
      if (missing.length > 0) throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    },
    ...options
  })
}

function createDatabaseTestSuite (pluginName, packageName, TestSetupClass, testCallback, options = {}) {
  return createTestSuite(pluginName, packageName, TestSetupClass, (helper) => {
    // First, generate standard database test cases
    const databaseHelper = new DatabaseTestHelper(pluginName, packageName, TestSetupClass)
    databaseHelper.generateTestCases(helper)

    // Then run custom test cases
    if (testCallback) {
      testCallback(helper)
    }
  }, {
    testAgentOptions: { host: 'localhost', port: 9126 },
    validateTestSetup: (testSetup, pluginName) => {
      const required = ['performRead', 'performWrite']
      const missing = required.filter(method => typeof testSetup[method] !== 'function')
      if (missing.length > 0) throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    },
    ...options
  })
}

module.exports = {
  createTestSuite,
  createWebServerTestSuite,
  createMessagingTestSuite,
  createDatabaseTestSuite,
  IntegrationTestHelper,
  WebServerTestHelper,
  DatabaseTestHelper,
  MessagingTestHelper
}
