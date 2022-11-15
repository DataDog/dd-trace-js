'use strict'

const { channel } = require('diagnostics_channel')
const { isFalse } = require('./util')
const plugins = require('./plugins')
const log = require('./log')

const loadChannel = channel('dd-trace:instrumentation:load')

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')
if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) { 
  // instrument lambda environment
  require('../../../lambda')
}

const { DD_TRACE_DISABLED_PLUGINS } = process.env

const disabledPlugins = new Set(
  DD_TRACE_DISABLED_PLUGINS && DD_TRACE_DISABLED_PLUGINS.split(',').map(plugin => plugin.trim())
)

// TODO actually ... should we be looking at envrionment variables this deep down in the code?

const pluginClasses = {}

loadChannel.subscribe(({ name }) => {
  const Plugin = plugins[name]

  if (!Plugin || typeof Plugin !== 'function') return
  if (!pluginClasses[Plugin.name]) {
    const envName = `DD_TRACE_${Plugin.name.toUpperCase()}_ENABLED`
    const enabled = process.env[envName.replace(/[^a-z0-9_]/ig, '_')]

    // TODO: remove the need to load the plugin class in order to disable the plugin
    if (isFalse(enabled) || disabledPlugins.has(Plugin.name)) {
      log.debug(`Plugin "${Plugin.name}" was disabled via configuration option.`)

      pluginClasses[Plugin.name] = null
    } else {
      pluginClasses[Plugin.name] = Plugin
    }
  }
})

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

      this.loadPlugin(Plugin.name)
    }

    loadChannel.subscribe(this._loadedSubscriber)
  }

  loadPlugin (name) {
    const Plugin = pluginClasses[name]

    if (!Plugin) return
    if (!this._pluginsByName[name]) {
      this._pluginsByName[name] = new Plugin(this._tracer)
    }
    if (!this._tracerConfig) return // TODO: don't wait for tracer to be initialized

    const pluginConfig = this._configsByName[name] || {
      enabled: this._tracerConfig.plugins !== false
    }

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
      clientIpHeaderDisabled,
      clientIpHeader,
      isIntelligentTestRunnerEnabled,
      site,
      experimental
    } = this._tracerConfig

    const sharedConfig = {}

    if (logInjection !== undefined) {
      sharedConfig.logInjection = logInjection
    }

    if (queryStringObfuscation !== undefined) {
      sharedConfig.queryStringObfuscation = queryStringObfuscation
    }

    if (clientIpHeaderDisabled !== undefined) {
      sharedConfig.clientIpHeaderDisabled = clientIpHeaderDisabled
    }

    if (clientIpHeader !== undefined) {
      sharedConfig.clientIpHeader = clientIpHeader
    }

    if (experimental) {
      sharedConfig.isAgentlessEnabled = experimental.exporter === 'datadog'
    }

    sharedConfig.isIntelligentTestRunnerEnabled = isIntelligentTestRunnerEnabled

    if (serviceMapping && serviceMapping[name]) {
      sharedConfig.service = serviceMapping[name]
    }

    sharedConfig.site = site

    return sharedConfig
  }
}
