'use strict'

const { info, warn } = require('./log/writer')

const os = require('os')
const { inspect } = require('util')
const defaults = require('./config_defaults')
const tracerVersion = require('../../../package.json').version

const errors = {}
let config
let pluginManager
let samplingRules = []
let alreadyRan = false

/**
 * @returns {Record<string, unknown>}
 */
function getIntegrationsAndAnalytics () {
  return {
    integrations_loaded: Object.keys(pluginManager._pluginsByName)
  }
}

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
    }
  }

  out.date = new Date().toISOString()
  out.os_name = os.type()
  out.os_version = os.release()
  out.architecture = os.arch()
  out.version = tracerVersion
  out.lang = 'nodejs'
  out.lang_version = process.versions.node
  out.env = config.env
  out.enabled = config.enabled
  out.service = config.service
  out.agent_url = url
  out.debug = !!config.debug
  out.sample_rate = config.sampler.sampleRate
  out.sampling_rules = samplingRules
  out.tags = config.tags
  if (config.tags && config.tags.version) {
    out.dd_version = config.tags.version
  }

  out.log_injection_enabled = !!config.logInjection
  out.runtime_metrics_enabled = !!config.runtimeMetrics
  const profilingEnabled = config.profiling?.enabled
  out.profiling_enabled = profilingEnabled === 'true' || profilingEnabled === 'auto'
  Object.assign(out, getIntegrationsAndAnalytics())

  out.appsec_enabled = !!config.appsec.enabled

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
 * @param {import('./sampling_rule')} theRules
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
