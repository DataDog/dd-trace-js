'use strict'

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')
const integrationTestCasesByClass = require('./integration-test-cases')
const { createValidatedTestSetup } = require('./operation-validator')

function createIntegrationTestSuite (pluginName, packageName, TestSetupClass, options, testCallback) {
    describe('Plugin', () => {
        describe(pluginName, () => {
            withVersions(pluginName, packageName, version => {
                createVersionedTests(pluginName, packageName, TestSetupClass, options, version, testCallback)
            })
        })
    })
}

function createVersionedTests (pluginName, packageName, TestSetupClass, options = {}, version, testCallback) {
    const testSetup = new TestSetupClass()
    let tracer = null
    let mod = null
    let testCase

    describe('without configuration', () => {
        before(async () => {
            const plugins = [pluginName, ...(options.additionalPlugins || [])]
            const pluginConfigs = [options.pluginConfig || {}, ...(options.additionalPlugins || []).map(() => ({}))]
            await agent.load(plugins, pluginConfigs)
        })

        after(async () => {
            await agent.close({ ritmReset: false })
        })

        before(async () => {
            tracer = require('../../../../../dd-trace').init()
            mod = require(`../../../../../../versions/${packageName}@${version}`)
            mod = options.subModule ? mod.get(options.subModule) : mod.get()
            testCase.mod = mod
            await testSetup.setup(mod)
        })

        after(async () => {
            if (testSetup?.teardown) {
                await testSetup.teardown()
            }
        })

        // Wrap test setup with validation proxy if category/role specified
        const validatedTestSetup = (options.category && options.role)
            ? createValidatedTestSetup(testSetup, options.category, options.role)
            : testSetup

        testCase = createTestCase({
            pluginName,
            packageName,
            category: options.category,
            role: options.role,
            testSetup: validatedTestSetup,
            agent,
            tracer
        })

        testCase.generateTestCases()

        if (testCallback) {
            testCallback({
                testCase,
                testSetup,
                agent,
                tracer,
                expect,
                describe,
                it,
                beforeEach,
                afterEach,
                mod
            })
        }
    })
}


function createTestCase (config) {
    const TestCaseClass = integrationTestCasesByClass[config.category]
    if (!TestCaseClass) {
        throw new Error(`No test scaffolder found for category: ${config.category}`)
    }
    return new TestCaseClass(config)
}

module.exports = { createIntegrationTestSuite }