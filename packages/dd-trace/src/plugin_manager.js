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
  return new Set(disabledPlugins && disabledPlugins.split(',').map(plugin => plugin.trim()))
}

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._tracer = tracer
    this._pluginsByName = {}
    this._configsByName = {}
    this._disabledPlugins = collectDisabledPlugins()
  }

  // like instrumenter.use()
  configurePlugin (name, pluginConfig) {
    if (typeof pluginConfig === 'boolean') {
      pluginConfig = { enabled: pluginConfig }
    }
    if (!pluginConfig) {
      pluginConfig = { enabled: true }
    }

    this._configsByName[name] = {
      ...this._configsByName[name],
      ...pluginConfig
    }

    if (this._pluginsByName[name]) {
      this._pluginsByName[name].configure(getConfig(name, this._configsByName[name]))
    }
  }

  // like instrumenter.enable()
  configure (config = {}) {
    const { logInjection, serviceMapping, experimental } = config

    for (const PluginClass of Object.values(plugins)) {
      const name = PluginClass.name

      if (this._disabledPlugins.has(name)) {
        log.debug(`Plugin "${name}" was disabled via configuration option.`)
        continue
      }

      if (typeof PluginClass !== 'function') continue

      this._pluginsByName[name] = new PluginClass(this._tracer)

      if (config.plugins === false) continue

      const pluginConfig = {
        ...this._configsByName[name]
      }

      if (logInjection !== undefined) {
        pluginConfig.logInjection = logInjection
      }

      // TODO: update so that it's available for every CI Visibility's plugin
      if (name === 'mocha') {
        pluginConfig.isAgentlessEnabled = experimental && experimental.exporter === 'datadog'
      }

      if (serviceMapping && serviceMapping[name]) {
        pluginConfig.service = serviceMapping[name]
      }

      this.configurePlugin(name, pluginConfig)
    }
  }

  // This is basically just for testing. like intrumenter.disable()
  destroy () {
    for (const name in this._pluginsByName) {
      this._pluginsByName[name].configure({ enabled: false })
    }

    this._pluginsByName = {}
    this._configsByName = {}
  }
}
