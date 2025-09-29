'use strict'

const { describe, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')
const { TestAgentClient } = require('../test-agent/client')
const scaffolders = require('./integration-class-test-scaffolders')

// Core test scaffolding with APM test agent integration
function createIntegrationTestSuite (pluginName, packageName, TestSetupClass, options, testCallback) {
  const opts = options || {}
  const config = {
    skipVersions: opts.skipVersions || false,
    additionalPlugins: opts.additionalPlugins || [],
    pluginConfig: opts.pluginConfig || {},
    testAgentOptions: opts.testAgentOptions || { host: 'localhost', port: 9126 },
    validateTestSetup: opts.validateTestSetup || null,
    pluginName,
    packageName,
    TestSetupClass,
    ...opts
  }

  describe('Plugin', () => {
    describe(pluginName, () => {
      withVersions(pluginName, packageName, version => {
        createVersionedTests(pluginName, packageName, TestSetupClass, testCallback, config, version)
      })
    })
  })
}

function createVersionedTests (pluginName, packageName, TestSetupClass, testCallback, config, version) {
  const testSetup = new TestSetupClass()
  let mod = null
  let tracer = null

  beforeEach(() => {
    tracer = require('../../../../../dd-trace')
  })

  createTestBlocks(pluginName, packageName, testSetup, testCallback, config, version, {
    getMod: () => mod,
    getTracer: () => tracer,
    setMod: (module) => { mod = module }
  })
}

function createTestBlocks (pluginName, packageName, testSetup, testCallback, config, version, state) {
  let helper
  describe('without configuration', () => {
    let testAgentClient = null
    let sessionToken = null

    before(async () => {
      const plugins = [pluginName, ...config.additionalPlugins]
      const configs = [config.pluginConfig, ...config.additionalPlugins.map(() => ({}))]
      await agent.load(plugins, configs)

      testAgentClient = new TestAgentClient(config.testAgentOptions)
      const versionSuffix = version ? `_v${version}` : ''
      sessionToken = testAgentClient.generateSessionToken(`${pluginName}${versionSuffix}`)
      try {
        await testAgentClient.startSession(sessionToken, {
          agentSampleRateByService: config.agentSampleRateByService
        })

        await testAgentClient.updateIntegrationInfo(sessionToken, {
          integration_name: pluginName,
          integration_version: version || 'latest',
          dependency_name: packageName,
          tracer_language: 'javascript',
          tracer_version: process.env.DD_TRACE_VERSION || 'test'
        })
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`Test agent not available: ${error.message}`)
        testAgentClient = null
        sessionToken = null
      }
    })

    after(async () => {
      if (testAgentClient && sessionToken) {
        try {
          const failures = await testAgentClient.getTraceCheckFailures(sessionToken, { useJson: true })
          const summary = await testAgentClient.getTraceCheckSummary(sessionToken)
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

          await testAgentClient.clearTraceCheckFailures(sessionToken)
        } catch (error) {
          if (error.message.includes('failed trace checks')) {
            throw error
          }
          // eslint-disable-next-line no-console
          console.warn(`Error getting trace check results: ${error.message}`)
        }
      }

      await agent.close({ ritmReset: false })
    })

    beforeEach(async () => {
      if (version) {
        helper.mod = require(`../../../../../../versions/${packageName}@${version}`).get()
      } else {
        helper.mod = require(packageName)
      }
      console.log('createTestBlocks beforeEach with version', version)
      await testSetup.setup(helper.mod)
      if (config.validateTestSetup) {
        config.validateTestSetup(testSetup, pluginName)
      }
    })

    afterEach(async () => {
      if (testSetup && testSetup.cleanup) {
        await testSetup.cleanup()
      }
    })

    helper = createTestHelperClass({
      ...config,
      testSetup,
      mod: state.getMod(),
      tracer: state.getTracer(),
      testAgentClient,
      sessionToken,
      pluginName,
      packageName,
    })

    helper.generateTestCases()

    if (testCallback) {
      testCallback(helper)
    }
  })
}

function createTestHelperClass (config) {
  const ScaffolderClass = scaffolders[config.pluginType]
  if (!ScaffolderClass) {
    throw new Error(`No test scaffolder found for type: ${config.pluginType}`)
  }
  return new ScaffolderClass(config)
}

module.exports = { createIntegrationTestSuite }
