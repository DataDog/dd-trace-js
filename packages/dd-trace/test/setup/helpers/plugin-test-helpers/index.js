'use strict'

const { describe, before, after } = require('mocha')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')

function createIntegrationTestSuite (pluginName, packageName, options, testCallback) {
  describe('Plugin', () => {
    describe(pluginName, () => {
      withVersions(pluginName, packageName, version => {
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
          })

          testCallback({
            agent,
            tracer,
            mod
          })
        })
      })
    })
  })
}

module.exports = { createIntegrationTestSuite }
