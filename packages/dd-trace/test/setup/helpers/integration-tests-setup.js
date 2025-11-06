'use strict'

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')

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

    describe('without configuration', () => {
        before(async () => {
            const plugins = [pluginName, ...(options.additionalPlugins || [])]
            const additionalPluginConfigs = options.additionalPluginConfigs || []
            const pluginConfigs = [
                options.pluginConfig || {},
                ...(options.additionalPlugins || []).map((_, index) => additionalPluginConfigs[index] || {})
            ]
            await agent.load(plugins, pluginConfigs)
        })

        after(async () => {
            await agent.close({ ritmReset: false })
        })

        before(async () => {
            tracer = require('../../../../../dd-trace').init()
            mod = require(`../../../../../../versions/${packageName}@${version}`)
            mod = options.subModule ? mod.get(options.subModule) : mod.get()
            await testSetup.setup(mod)
        })

        after(async () => {
            if (testSetup?.teardown) {
                await testSetup.teardown()
            }
        })

        const testCase = {
            pluginName,
            packageName,
            category: options.category,
            role: options.role,
            testSetup,
            agent,
            tracer,
            mod
        }

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

module.exports = { createIntegrationTestSuite }
