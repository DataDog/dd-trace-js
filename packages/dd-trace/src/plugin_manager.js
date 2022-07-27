'use strict'

const { channel } = require('diagnostics_channel')
const { isTrue } = require('./util')
const plugins = require('./plugins')
const log = require('./log')

const loadChannel = channel('dd-trace:instrumentation:load')

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')

// TODO this is shared w/ instrumenter. DRY up.
function getConfig (name, config) {
  config = { ...config }

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

const { DD_TRACE_DISABLED_PLUGINS } = process.env

const disabledPlugins = new Set(
  DD_TRACE_DISABLED_PLUGINS && DD_TRACE_DISABLED_PLUGINS.split(',').map(plugin => plugin.trim())
)

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

const pluginClasses = {}

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._tracer = tracer
    this._tracerConfig = {}
    this._pluginsByName = {}
    this._configsByName = {}

    this._loadedSubscriber = ({ name }) => {
      const Plugin = plugins[name]

      if (Plugin && typeof Plugin === 'function' && !pluginClasses[Plugin.name]) {
        // TODO: remove the need to load the plugin class in order to disable the plugin
        if (disabledPlugins.has(Plugin.name)) {
          log.debug(`Plugin "${Plugin.name}" was disabled via configuration option.`)

          // TODO: clean this up
          pluginClasses[Plugin.name] = class NoopPlugin {
            configure () {}
          }
        } else {
          pluginClasses[Plugin.name] = Plugin
        }

        this.configurePlugin(Plugin.name, this._configsByName[name])
      }
    }

    loadChannel.subscribe(this._loadedSubscriber)
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
      ...this._getSharedConfig(name),
      ...pluginConfig
    }

    const Plugin = pluginClasses[name]

    if (!Plugin) return
    if (!this._pluginsByName[name]) {
      this._pluginsByName[name] = new Plugin(this._tracer)
    }

    // console.log(this._configsByName[name])
    this._pluginsByName[name].configure(getConfig(name, this._configsByName[name]))
  }

  // like instrumenter.enable()
  configure (config = {}) {
    this._tracerConfig = config
  }

  // This is basically just for testing. like intrumenter.disable()
  destroy () {
    for (const name in this._pluginsByName) {
      this._pluginsByName[name].configure({ enabled: false })
    }

    loadChannel.unsubscribe(this._loadedSubscriber)
  }

  // TODO: figure out a better way to handle this
  _getSharedConfig (name) {
    const {
      logInjection,
      serviceMapping,
      experimental,
      queryStringObfuscation
    } = this._tracerConfig

    const sharedConfig = {}

    if (logInjection !== undefined) {
      sharedConfig.logInjection = logInjection
    }

    if (queryStringObfuscation !== undefined) {
      sharedConfig.queryStringObfuscation = queryStringObfuscation
    }

    // TODO: update so that it's available for every CI Visibility's plugin
    if (name === 'mocha') {
      sharedConfig.isAgentlessEnabled = experimental && experimental.exporter === 'datadog'
    }

    if (serviceMapping && serviceMapping[name]) {
      sharedConfig.service = serviceMapping[name]
    }

    return sharedConfig
  }
}
