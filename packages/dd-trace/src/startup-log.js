'use strict'

const { info, warn } = require('./log/writer')

const os = require('os')
const { inspect } = require('util')
const defaults = require('./config_defaults')
const tracerVersion = require('../../../package.json').version

const errors = {}
let config
let pluginManager
/** @type {import('./sampling_rule')[]} */
let samplingRules = []
let alreadyRan = false

/**
 * @param {{ agentError: { code: string, message: string } }} [options]
 */
function startupLog ({ agentError } = {}) {
  if (!config || !pluginManager) {
    return
  }

  if (alreadyRan) {
    return
  }

  alreadyRan = true

  if (!config.startupLogs) {
    return
  }

  const out = tracerInfo()

  if (agentError) {
    out.agent_error = agentError.message
  }

  info('DATADOG TRACER CONFIGURATION - ' + out)
  if (agentError) {
    warn('DATADOG TRACER DIAGNOSTIC - Agent Error: ' + agentError.message)
    errors.agentError = {
      code: agentError.code ?? '',
      message: `Agent Error:${agentError.message}`
    }
  }
}

/**
 * @returns {Record<string, unknown>}
 */
function tracerInfo () {
  const url = config.url || `http://${config.hostname || defaults.hostname}:${config.port}`

  const out = {
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
    integrations_loaded: Object.keys(pluginManager._pluginsByName),
    appsec_enabled: !!config.appsec.enabled,
  }

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
  setStartupLogConfig,
  setStartupLogPluginManager,
  setSamplingRules,
  tracerInfo,
  errors
}
