'use strict'

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')

function createIntegrationTestSuite (pluginName, packageName, testSetup, options, testCallback) {
  describe('Plugin', () => {
    describe(pluginName, () => {
      withVersions(pluginName, packageName, version => {
        createVersionedTests(pluginName, packageName, testSetup, options, version, testCallback)
      })
    })
  })
}

function createVersionedTests (pluginName, packageName, testSetup, options = {}, version, testCallback) {
  let tracer = null
  let mod = null

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
      await testSetup.setup(mod)
    })

    after(async () => {
      if (testSetup?.teardown) {
        await testSetup.teardown()
      }
    })

    if (testCallback) {
      testCallback({
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
