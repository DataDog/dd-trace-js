'use strict'

const { isTrue } = require('./util')
const plugins = require('./plugins')

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')

// TODO this is shared w/ instrumenter. DRY up.
function getConfig (name, config = {}) {
  const enabled = process.env[`DD_TRACE_${name.toUpperCase()}_ENABLED`.replace(/[^a-z0-9_]/ig, '_')]
  if (enabled !== undefined) {
    config.enabled = isTrue(enabled)
  }

  // TODO is this the best/correct place for this default?
  if (!('enabled' in config)) {
    config.enabled = true
  }

  return config
}

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._pluginsByName = {}
    for (const PluginClass of Object.values(plugins)) {
      if (typeof PluginClass !== 'function') continue
      this._pluginsByName[PluginClass.name] = new PluginClass(tracer)
    }
  }

  // like instrumenter.use()
  configurePlugin (name, pluginConfig) {
    if (!(name in this._pluginsByName)) return
    if (typeof pluginConfig === 'boolean') {
      pluginConfig = { enabled: pluginConfig }
    }

    this._pluginsByName[name].configure(getConfig(name, pluginConfig))
  }

  // like instrumenter.enable()
  configure (config) {
    const serviceMapping = config.serviceMapping

    if (config.plugins !== false) {
      for (const name in this._pluginsByName) {
        const pluginConfig = {}
        if (serviceMapping && serviceMapping[name]) {
          pluginConfig.service = serviceMapping[name]
        }
        this.configurePlugin(name, pluginConfig)
      }
    }
  }

  // This is basically just for testing. like intrumenter.disable()
  destroy () {
    for (const name in this._pluginsByName) this._pluginsByName[name].configure({ enabled: false })
  }
}
