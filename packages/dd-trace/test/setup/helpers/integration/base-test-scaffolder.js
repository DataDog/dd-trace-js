'use strict'

const { describe, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')
const { TestAgentClient } = require('../test-agent/client')
const scaffolders = require('./integration-class-test-scaffolders')

// Core test scaffolding with APM test agent integration
function createIntegrationTestSuite (pluginName, packageName, TestSetupClass, options, testCallback) {
  const config = normalizeConfig(pluginName, packageName, options)

  describe('Plugin', () => {
    describe(pluginName, () => {
      withVersions(pluginName, packageName, version => {
        createVersionedTests(TestSetupClass, config, version, testCallback)
      })
    })
  })
}

function normalizeConfig (pluginName, packageName, options = {}) {
  return {
    pluginName,
    packageName,
    skipVersions: options.skipVersions || false,
    additionalPlugins: options.additionalPlugins || [],
    pluginConfig: options.pluginConfig || {},
    testAgentOptions: options.testAgentOptions || { host: 'localhost', port: 9126 },
    validateTestSetup: options.validateTestSetup || null,
    pluginType: options.pluginType
  }
}

function createVersionedTests (TestSetupClass, config, version, testCallback) {
  const testSetup = new TestSetupClass()
  let tracer = null

  beforeEach(() => {
    tracer = require('../../../../../dd-trace')
  })

  createTestBlocks(testSetup, config, version, () => tracer, testCallback)
}

function createTestBlocks (testSetup, config, version, getTracer, testCallback) {
  describe('without configuration', () => {
    let testAgentClient = null
    let sessionToken = null
    let helper = null
    let mod = null

    before(async () => {
      const plugins = [config.pluginName, ...config.additionalPlugins]
      const pluginConfigs = [config.pluginConfig, ...config.additionalPlugins.map(() => ({}))]
      await agent.load(plugins, pluginConfigs)

      testAgentClient = await initTestAgent(config, version)
      sessionToken = testAgentClient?.sessionToken || null
    })

    after(async () => {
      await reportTraceChecks(testAgentClient, sessionToken, config.pluginName)
      await agent.close({ ritmReset: false })
    })

    beforeEach(async () => {
      mod = loadModule(config.packageName, version)
      await testSetup.setup(mod)
      if (config.validateTestSetup) {
        config.validateTestSetup(testSetup, config.pluginName)
      }
    })

    afterEach(async () => {
      if (testSetup?.teardown) {
        await testSetup.teardown()
      }
    })

    helper = createTestHelper({
      ...config,
      testSetup,
      getModule: () => mod,
      getTracer,
      testAgentClient,
      sessionToken
    })

    helper.generateTestCases()

    if (testCallback) {
      testCallback(helper)
    }
  })
}

function loadModule (packageName, version) {
  if (version) {
    return require(`../../../../../../versions/${packageName}@${version}`).get()
  }
  return require(packageName)
}

async function initTestAgent (config, version) {
  const client = new TestAgentClient(config.testAgentOptions)
  const versionSuffix = version ? `_v${version}` : ''
  const sessionToken = client.generateSessionToken(`${config.pluginName}${versionSuffix}`)

  try {
    await client.startSession(sessionToken, {
      agentSampleRateByService: config.agentSampleRateByService
    })

    await client.updateIntegrationInfo(sessionToken, {
      integration_name: config.pluginName,
      integration_version: version || 'latest',
      dependency_name: config.packageName,
      tracer_language: 'javascript',
      tracer_version: process.env.DD_TRACE_VERSION || 'test'
    })

    return { client, sessionToken }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Test agent not available: ${error.message}`)
    return null
  }
}

async function reportTraceChecks (testAgent, sessionToken, pluginName) {
  if (!testAgent?.client || !sessionToken) return

  const client = testAgent.client

  try {
    const failures = await client.getTraceCheckFailures(sessionToken, { useJson: true })
    const summary = await client.getTraceCheckSummary(sessionToken)

    if (summary.statusCode === 200 && summary.body) {
      // eslint-disable-next-line no-console
      console.log(`\n📊 Trace Check Summary for ${pluginName}:`)
      Object.entries(summary.body).forEach(([checkName, results]) => {
        const { Passed_Checks: passed, Failed_Checks: failed, Skipped_Checks: skipped } = results
        // eslint-disable-next-line no-console
        console.log(`  ${checkName}: ✅ ${passed} passed, ❌ ${failed} failed, ⏭️ ${skipped} skipped`)
      })
    }

    if (failures.statusCode === 400) {
      // eslint-disable-next-line no-console
      console.error(`\n❌ Trace Check Failures for ${pluginName}:`)
      if (failures.body && typeof failures.body === 'object') {
        Object.entries(failures.body).forEach(([checkName, messages]) => {
          // eslint-disable-next-line no-console
          console.error(`  ${checkName}:`)
          // eslint-disable-next-line no-console
          messages.forEach(msg => console.error(`    - ${msg}`))
        })
      } else {
        // eslint-disable-next-line no-console
        console.error(`  ${failures.rawBody}`)
      }

      throw new Error(`Integration ${pluginName} failed trace checks. See details above.`)
    }

    await client.clearTraceCheckFailures(sessionToken)
  } catch (error) {
    if (error.message.includes('failed trace checks')) {
      throw error
    }
    // eslint-disable-next-line no-console
    console.warn(`Error getting trace check results: ${error.message}`)
  }
}

function createTestHelper (config) {
  const HelperClass = scaffolders[config.pluginType]
  if (!HelperClass) {
    throw new Error(`No test scaffolder found for type: ${config.pluginType}`)
  }
  return new HelperClass(config)
}

module.exports = { createIntegrationTestSuite }
