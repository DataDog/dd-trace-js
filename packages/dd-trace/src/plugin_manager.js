'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')
const { isFalse, isTrue, normalizePluginEnvName } = require('./util')
const plugins = require('./plugins')
const log = require('./log')

// Test optimization plugins that should only be enabled when isCiVisibility is true
const TEST_OPTIMIZATION_PLUGINS = new Set([
  'jest',
  'vitest',
  'cucumber',
  'mocha',
  'playwright',
])

const loadChannel = channel('dd-trace:instrumentation:load')

const DD_TRACE_DISABLED_PLUGINS = getValueFromEnvSources('DD_TRACE_DISABLED_PLUGINS')

const disabledPlugins = new Set(
  DD_TRACE_DISABLED_PLUGINS && DD_TRACE_DISABLED_PLUGINS.split(',').map(plugin => plugin.trim())
)

// TODO actually ... should we be looking at environment variables this deep down in the code?

const pluginClasses = {}

// Subscribe before requiring instrumentations so that loadChannel events fired
// during instrumentation initialization (e.g. re-requires in bundler contexts)
// are captured and populate pluginClasses correctly.
loadChannel.subscribe(({ name }) => {
  maybeEnable(plugins[name])
})

// instrument everything that needs Plugin System V2 instrumentation
require('../../datadog-instrumentations')
if (getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined) {
  // instrument lambda environment
  require('./lambda')
}

function maybeEnable (Plugin) {
  if (!Plugin || typeof Plugin !== 'function') return
  if (!pluginClasses[Plugin.id]) {
    const enabled = getEnabled(Plugin)

    // TODO: remove the need to load the plugin class in order to disable the plugin
    if (isFalse(enabled) || disabledPlugins.has(Plugin.id)) {
      log.debug('Plugin "%s" was disabled via configuration option.', Plugin.id)

      pluginClasses[Plugin.id] = null
    } else {
      pluginClasses[Plugin.id] = Plugin
    }
  }
}

function getEnabled (Plugin) {
  const envName = `DD_TRACE_${Plugin.id.toUpperCase()}_ENABLED`
  // skipDefault: only an explicitly configured value should drive enablement here. A registered
  // default of `false` (e.g. an experimental plugin like `nats`) must not be read as an explicit
  // "disabled via configuration option" — that path both logs a misleading line and nulls the
  // plugin class, bypassing the experimental opt-in handled by `loadPlugin`.
  return getValueFromEnvSources(normalizePluginEnvName(envName), true)
}

// TODO this must always be a singleton.
module.exports = class PluginManager {
  constructor (tracer) {
    this._tracer = tracer
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

    // Check if this is a Test Optimization plugin and Test Optimization is not enabled
    if (TEST_OPTIMIZATION_PLUGINS.has(name) && !this._tracerConfig.isCiVisibility) {
      log.debug('Plugin "%s" is not initialized because Test Optimization mode is not enabled.', name)
      return
    }

    if (!this._pluginsByName[name]) {
      this._pluginsByName[name] = new Plugin(this._tracer, this._tracerConfig)
    }
    const pluginConfig = this._configsByName[name] || {
      enabled: this._tracerConfig.plugins !== false &&
        (!Plugin.experimental || isTrue(getEnabled(Plugin))),
    }

    // extracts predetermined configuration from tracer and combines it with plugin-specific config
    this._pluginsByName[name].configure({
      ...this.#getSharedConfig(name),
      ...pluginConfig,
    })
  }

  // TODO: merge config instead of replacing
  configurePlugin (name, pluginConfig) {
    const enabled = this._isEnabled(pluginConfig)

    this._configsByName[name] = {
      ...pluginConfig,
      enabled,
    }

    this.loadPlugin(name)
  }

  /**
   * Like instrumenter.enable()
   * @param {import('./config/config-base')} config - Tracer configuration
   */
  configure (config) {
    this._tracerConfig = config
    this._tracer._nomenclature.configure(config)

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
  #getSharedConfig (name) {
    const {
      logInjection,
      serviceMapping,
      DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      site,
      url,
      headerTags,
      codeOriginForSpans,
      dbmPropagationMode,
      dsmEnabled,
      clientIpEnabled,
      clientIpHeader,
      DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      DD_TRACE_OTEL_SEMANTICS_ENABLED,
      DD_TRACE_GRAPHQL_COLLAPSE,
      DD_TRACE_GRAPHQL_DEPTH,
      DD_TRACE_GRAPHQL_VARIABLES,
      DD_TRACE_GRAPHQL_ERROR_EXTENSIONS,
      DD_TEST_SESSION_NAME,
      DD_AGENTLESS_LOG_SUBMISSION_ENABLED,
      testOptimization,
      isServiceUserProvided,
      middlewareTracingEnabled,
      traceWebsocketMessagesEnabled,
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces,
      experimental,
      DD_TRACE_RESOURCE_RENAMING_ENABLED,
    } = /** @type {import('./config/config-base')} */ (this._tracerConfig)

    const sharedConfig = {
      codeOriginForSpans,
      dbmPropagationMode,
      dsmEnabled,
      DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      DD_TRACE_OTEL_SEMANTICS_ENABLED,
      site,
      url,
      headers: headerTags,
      clientIpHeader,
      DD_TEST_SESSION_NAME,
      DD_AGENTLESS_LOG_SUBMISSION_ENABLED,
      isTestDynamicInstrumentationEnabled: testOptimization.DD_TEST_FAILED_TEST_REPLAY_ENABLED,
      isServiceUserProvided,
      traceWebsocketMessagesEnabled,
      traceWebsocketMessagesInheritSampling,
      traceWebsocketMessagesSeparateTraces,
      experimental,
      resourceRenamingEnabled: DD_TRACE_RESOURCE_RENAMING_ENABLED,
    }

    if (logInjection !== undefined) {
      sharedConfig.logInjection = logInjection
    }

    if (DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP !== undefined) {
      sharedConfig.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP
    }

    if (serviceMapping && serviceMapping[name]) {
      sharedConfig.service = serviceMapping[name]
    }

    if (clientIpEnabled !== undefined) {
      sharedConfig.clientIpEnabled = clientIpEnabled
    }

    // For the global setting, we use the name `middlewareTracingEnabled`, but
    // for the plugin-specific setting, we use `middleware`. They mean the same
    // to an individual plugin, so we normalize them here.
    if (middlewareTracingEnabled !== undefined) {
      sharedConfig.middleware = middlewareTracingEnabled
    }

    // The graphql `DD_TRACE_GRAPHQL_*` options are global on purpose: they feed
    // the plugin config as a base that a programmatic `tracer.use('graphql', …)`
    // overrides, and stay on the Config singleton so remote config and config
    // telemetry observe them. Forwarded only for graphql so other plugins do not
    // carry keys they ignore. The plugin-facing names drop the prefix.
    if (name === 'graphql') {
      sharedConfig.collapse = DD_TRACE_GRAPHQL_COLLAPSE
      sharedConfig.depth = DD_TRACE_GRAPHQL_DEPTH
      sharedConfig.variables = DD_TRACE_GRAPHQL_VARIABLES
      sharedConfig.errorExtensions = DD_TRACE_GRAPHQL_ERROR_EXTENSIONS
    }

    return sharedConfig
  }
}
