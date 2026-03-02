'use strict'

const { describe, before, after } = require('mocha')
const agent = require('../../../plugins/agent')
const { withVersions } = require('../../mocha')

function createIntegrationTestSuite (pluginName, packageName, options, testCallback) {
  describe('Plugin', () => {
    describe(pluginName, () => {
      withVersions(pluginName, packageName, version => {
        const meta = { agent, tracer: null, mod: null }

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
            meta.tracer = require('../../../../../dd-trace').init()
            const mod = require(`../../../../../../versions/${packageName}@${version}`)
            meta.mod = options.subModule ? mod.get(options.subModule) : mod.get()
          })

          testCallback(meta)
        })
      })
    })
  })
}

module.exports = { createIntegrationTestSuite }
