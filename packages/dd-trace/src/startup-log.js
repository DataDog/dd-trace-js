'use strict'

const os = require('os')
const { inspect } = require('util')
const tracerVersion = require('../../../package.json').version
const { getAgentUrl } = require('./agent/url')
const { warn } = require('./log/writer')

const errors = {}
let config
let pluginManager
/** @type {import('./sampling_rule')[]} */
let samplingRules = []
let configAlreadyRan = false
let integrationsAlreadyRan = false
let agentErrorAlreadyRan = false

/**
 * Logs DATADOG TRACER CONFIGURATION immediately at init time.
 * Excludes integrations_loaded since plugins haven't loaded yet.
 */
function startupLog () {
  if (configAlreadyRan || !config || !config.startupLogs) {
    return
  }

  configAlreadyRan = true

  const out = configInfo()

  warn('DATADOG TRACER CONFIGURATION - ' + out)
}

/**
 * Logs loaded integrations. Called from writer.js on first agent payload,
 * by which time the app has loaded its dependencies.
 */
function logIntegrations () {
  if (integrationsAlreadyRan || !config || !config.startupLogs || !pluginManager) {
    return
  }

  integrationsAlreadyRan = true

  warn('DATADOG TRACER INTEGRATIONS LOADED - ' + JSON.stringify(Object.keys(pluginManager._pluginsByName)))
}

/**
 * Logs agent error diagnostic.
 * @param {{ status: number, message: string }} agentError
 */
function logAgentError (agentError) {
  if (agentErrorAlreadyRan || !config || !config.startupLogs) {
    return
  }

  agentErrorAlreadyRan = true

  warn('DATADOG TRACER DIAGNOSTIC - Agent Error: ' + agentError.message)
  errors.agentError = {
    code: agentError.status,
    message: `Agent Error: ${agentError.message}`,
  }
}

/**
 * Returns config info without integrations (used by startupLog).
 * @returns {Record<string, unknown>}
 */
function configInfo () {
  const url = getAgentUrl(config)

  return {
    [inspect.custom] () {
      return String(this)
    },
    toString () {
      return JSON.stringify(this, (_key_, value) => {
        return typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value
      })
    },
    date: new Date().toISOString(),
    os_name: os.type(),
    os_version: os.release(),
    architecture: os.arch(),
    version: tracerVersion,
    lang: 'nodejs',
    lang_version: process.versions.node,
    env: config.env,
    enabled: config.enabled,
    service: config.service,
    agent_url: url,
    debug: !!config.debug,
    sample_rate: config.sampler.sampleRate,
    sampling_rules: samplingRules,
    tags: config.tags,
    ...(config.tags && config.tags.version && { dd_version: config.tags.version }),
    log_injection_enabled: !!config.logInjection,
    runtime_metrics_enabled: !!config.runtimeMetrics,
    profiling_enabled: config.profiling?.enabled === 'true' || config.profiling?.enabled === 'auto',
    appsec_enabled: config.appsec.enabled,
    data_streams_enabled: !!config.dsmEnabled,
  }
}

/**
 * Returns full tracer info including integrations (used by flare module).
 * @returns {Record<string, unknown>}
 */
function tracerInfo () {
  const out = configInfo()
  out.integrations_loaded = Object.keys(pluginManager._pluginsByName)
  return out
}

/**
 * @param {import('./config')} aConfig
 */
function setStartupLogConfig (aConfig) {
  config = aConfig
}

/**
 * @param {import('./plugin_manager')} thePluginManager
 */
function setStartupLogPluginManager (thePluginManager) {
  pluginManager = thePluginManager
}

/**
 * @param {import('./sampling_rule')[]} theRules
 */
function setSamplingRules (theRules) {
  samplingRules = theRules
}

module.exports = {
  startupLog,
  logIntegrations,
  logAgentError,
  setStartupLogConfig,
  setStartupLogPluginManager,
  setSamplingRules,
  tracerInfo,
  errors,
}
