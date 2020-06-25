'use strict'

const mainLogger = require('./log')
const path = require('path')
const { inspect } = require('util')
const tracerVersion = require('../lib/version')

let os
try {
  os = require('os')
} catch (e) {
  // in browser
}

const logger = Object.create(mainLogger)
logger._enabled = process.env.DD_TRACE_STARTUP_LOGS !== '0'

let config
let plugins = []
let samplingRules = []

let alreadyRan = false

function getIntegrations () {
  const integrations = []
  for (const plugin of plugins) {
    if (plugin.versions) {
      try {
        const version = require(path.join(plugin.name, 'package.json')).version
        integrations.push(`${plugin.name}@${version}`)
      } catch (e) {
        integrations.push(plugin.name)
      }
    } else {
      integrations.push(plugin.name)
    }
  }
  return Array.from(new Set(integrations))
}

function startupLog (agentError) {
  if (!config) {
    return
  }

  if (alreadyRan) {
    return
  }

  alreadyRan = true

  const url = config.url || `http://${config.hostname || 'localhost'}:${config.port}`

  const out = {
    [inspect.custom] () {
      return String(this)
    },
    toString () {
      return JSON.stringify(this)
    }
  }

  out.date = new Date().toISOString()
  out.os_name = os.type()
  out.os_version = os.release()
  out.version = tracerVersion
  out.lang = 'nodejs'
  out.lang_version = process.versions.node
  out.env = config.env
  out.enabled = config.enabled
  out.scope_manager = config.scope
  out.service = config.service
  // out.enabled_cli // N/A
  out.agent_url = url
  if (agentError) {
    out.agent_error = agentError.message
  }
  out.debug = !!config.debug
  out.analytics_enabled = !!config.analytics
  out.sample_rate = config.sampleRate
  out.sampling_rules = samplingRules
  // out.sampling_rules_error // N/A
  // out.integration_XXX_analytics_enabled // N/A
  // out.integration_XXX_sample_rate // N/A
  out.tags = config.tags
  if (config.tags && config.tags.version) {
    out.app_version = config.tags.version
  }
  // out.service_mapping // N/A
  // out.service_mapping_error // N/A
  out.log_injection_enabled = !!config.logInjection
  out.runtime_metrics_enabled = !!config.runtimeMetrics
  out.integrations_loaded = getIntegrations()

  logger.info('DATADOG TRACER CONFIGURATION', out)
  if (agentError) {
    logger.warn('DATADOG TRACER DIAGNOSTIC', 'Agent Error:', agentError.message)
  }
}

function setStartupLogConfig (aConfig) {
  config = aConfig
}

function setStartupLogPlugins (thePlugins) {
  plugins = thePlugins
}

function setSamplingRules (theRules) {
  samplingRules = theRules
}

module.exports = os ? {
  startupLog,
  setStartupLogConfig,
  setStartupLogPlugins,
  setSamplingRules
} : {
  startupLog: () => {},
  setStartupLogConfig: () => {},
  setStartupLogPlugins: () => {},
  setSamplingRules: () => {}
}
