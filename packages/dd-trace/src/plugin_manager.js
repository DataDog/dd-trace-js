'use strict'

const { channel } = require('../../diagnostics_channel')
const { isFalse } = require('./util')
const plugins = require('./plugins')
const log = require('./log')
const Nomenclature = require('./service-naming')

const loadChannel = channel('dd-trace:instrumentation:load')

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')
if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
  // instrument lambda environment
  require('./lambda')
}

const { DD_TRACE_DISABLED_PLUGINS } = process.env

const disabledPlugins = new Set(
  DD_TRACE_DISABLED_PLUGINS && DD_TRACE_DISABLED_PLUGINS.split(',').map(plugin => plugin.trim())
)

// TODO actually ... should we be looking at environment variables this deep down in the code?

const pluginClasses = {}

loadChannel.subscribe(({ name }) => {
  maybeEnable(plugins[name])
})

// Globals
maybeEnable(require('../../datadog-plugin-fetch/src'))

function maybeEnable (Plugin) {
  if (!Plugin || typeof Plugin !== 'function') return
  if (!pluginClasses[Plugin.id]) {
    const envName = `DD_TRACE_${Plugin.id.toUpperCase()}_ENABLED`
    const enabled = process.env[envName.replace(/[^a-z0-9_]/ig, '_')]

    // TODO: remove the need to load the plugin class in order to disable the plugin
    if (isFalse(enabled) || disabledPlugins.has(Plugin.id)) {
      log.debug(`Plugin "${Plugin.id}" was disabled via configuration option.`)

      pluginClasses[Plugin.id] = null
    } else {
      pluginClasses[Plugin.id] = Plugin
    }
  }
}

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._tracer = tracer
    this._tracerConfig = null
    this._pluginsByName = {}
    this._configsByName = {}

    this._loadedSubscriber = ({ name }) => {
      const Plugin = plugins[name]

      if (!Plugin || typeof Plugin !== 'function') return

      this.loadPlugin(Plugin.id)
    }

    loadChannel.subscribe(this._loadedSubscriber)
  }

  loadPlugin (name) {
    const Plugin = pluginClasses[name]

    if (!Plugin) return
    if (!this._tracerConfig) return // TODO: don't wait for tracer to be initialized
    if (!this._pluginsByName[name]) {
      this._pluginsByName[name] = new Plugin(this._tracer, this._tracerConfig)
    }
    const pluginConfig = this._configsByName[name] || {
      enabled: this._tracerConfig.plugins !== false
    }

    // extracts predetermined configuration from tracer and combines it with plugin-specific config
    this._pluginsByName[name].configure({
      ...this._getSharedConfig(name),
      ...pluginConfig
    })
  }

  // TODO: merge config instead of replacing
  configurePlugin (name, pluginConfig) {
    const enabled = this._isEnabled(pluginConfig)

    this._configsByName[name] = {
      ...pluginConfig,
      enabled
    }

    this.loadPlugin(name)
  }

  // like instrumenter.enable()
  configure (config = {}) {
    this._tracerConfig = config
    Nomenclature.configure(config)

    for (const name in pluginClasses) {
      this.loadPlugin(name)
    }
  }

  // This is basically just for testing. like intrumenter.disable()
  destroy () {
    for (const name in this._pluginsByName) {
      this._pluginsByName[name].configure({ enabled: false })
    }

    loadChannel.unsubscribe(this._loadedSubscriber)
  }

  _isEnabled (pluginConfig) {
    if (typeof pluginConfig === 'boolean') return pluginConfig
    if (!pluginConfig) return true

    return pluginConfig.enabled !== false
  }

  // TODO: figure out a better way to handle this
  _getSharedConfig (name) {
    const {
      logInjection,
      serviceMapping,
      queryStringObfuscation,
      site,
      url,
      headerTags,
      dbmPropagationMode,
      dsmEnabled,
      clientIpEnabled
    } = this._tracerConfig

    const sharedConfig = {}

    if (logInjection !== undefined) {
      sharedConfig.logInjection = logInjection
    }

    if (queryStringObfuscation !== undefined) {
      sharedConfig.queryStringObfuscation = queryStringObfuscation
    }

    sharedConfig.dbmPropagationMode = dbmPropagationMode
    sharedConfig.dsmEnabled = dsmEnabled

    if (serviceMapping && serviceMapping[name]) {
      sharedConfig.service = serviceMapping[name]
    }

    if (clientIpEnabled !== undefined) {
      sharedConfig.clientIpEnabled = clientIpEnabled
    }

    sharedConfig.site = site
    sharedConfig.url = url
    sharedConfig.headers = headerTags || []

    return sharedConfig
  }
}
