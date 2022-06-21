'use strict'

const { isTrue } = require('./util')
const plugins = require('./plugins')
const log = require('./log')

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

// TODO: maybe needs to DRY up as well, but depending on how the remaining old plugins
// are migrated to the new system, can stay here for now, since this is the level
// this check maybe should be happening on, even if it deals with env variabls
const disabledPlugins = process.env.DD_TRACE_DISABLED_PLUGINS

const collectDisabledPlugins = () => {
  return new Set(disabledPlugins && disabledPlugins.split(',').map(plugin => plugin.trim().toLowerCase()))
}

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._pluginsByName = {}
    this._configsByName = {}

    const _disabledPlugins = collectDisabledPlugins()

    for (const PluginClass of Object.values(plugins)) {
      /**
       * disabling the plugin here instead of in `configure` so we don't waste subscriber
       * resources on a plugin that will eventually be disabled anyways
       */
      if (_disabledPlugins.has(PluginClass.name)) {
        log.debug(`Plugin "${PluginClass.name}" was disabled via configuration option.`)
        continue
      }
      if (typeof PluginClass !== 'function') continue
      this._pluginsByName[PluginClass.name] = new PluginClass(tracer)
      this._configsByName[PluginClass.name] = {}
    }
  }

  // like instrumenter.use()
  configurePlugin (name, pluginConfig) {
    if (!(name in this._pluginsByName)) return
    if (typeof pluginConfig === 'boolean') {
      pluginConfig = { enabled: pluginConfig }
    }

    const config = {
      ...this._configsByName[name],
      ...pluginConfig
    }

    this._pluginsByName[name].configure(getConfig(name, config))
  }

  // like instrumenter.enable()
  configure (config) {
    const { logInjection, serviceMapping } = config

    if (config.plugins !== false) {
      for (const name in this._pluginsByName) {
        const pluginConfig = {
          ...this._configsByName[name],
          logInjection
        }
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
