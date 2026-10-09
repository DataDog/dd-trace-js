'use strict'

const os = require('os')
const { inspect } = require('util')

const tracerVersion = require('../../../package.json').version
const { obfuscateQs } = require('./plugins/util/url')
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

function logGenericError (message) {
  if (!config?.startupLogs) {
    return
  }

  warn('DATADOG TRACER DIAGNOSTIC - Generic Error: ' + message)
}

/**
 * Returns config info without integrations (used by startupLog).
 * @returns {Record<string, unknown>}
 */
function configInfo () {
  const url = config.url
  const profilingEnabled = config.profiling.DD_PROFILING_ENABLED

  const startupLog = {
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
    log_injection_enabled: !!config.logInjection,
    runtime_metrics_enabled: !!config.runtimeMetrics,
    profiling_enabled: profilingEnabled === 'true' || profilingEnabled === 'auto',
    appsec_enabled: config.appsec.DD_APPSEC_ENABLED,
    data_streams_enabled: !!config.dsmEnabled,
    otlp_traces_export_enabled: config.OTEL_TRACES_EXPORTER === 'otlp' && !config.isCiVisibility,
    otlp_metrics_export_enabled: !!config.DD_METRICS_OTEL_ENABLED,
    otlp_logs_export_enabled: !!config.DD_LOGS_OTEL_ENABLED,
    DD_AGENT_HOST: config.hostname ?? null,
    DD_DATA_STREAMS_ENABLED: !!config.dsmEnabled,
    DD_DBM_PROPAGATION_MODE: config.dbmPropagationMode ?? null,
    DD_LOGS_OTEL_ENABLED: !!config.DD_LOGS_OTEL_ENABLED,
    DD_METRICS_OTEL_ENABLED: !!config.DD_METRICS_OTEL_ENABLED,
    DD_TRACE_OTEL_ENABLED: !!config.DD_TRACE_OTEL_ENABLED,
    DD_TRACE_OTEL_SEMANTICS_ENABLED: !!config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: !!config.spanRemoveIntegrationFromService,
    // JSON omits undefined values; keep unset settings distinguishable from unsupported ones.
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: config.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ?? null,
    OTEL_BSP_MAX_QUEUE_SIZE: config.OTEL_BSP_MAX_QUEUE_SIZE ?? null,
    OTEL_BSP_SCHEDULE_DELAY: config.OTEL_BSP_SCHEDULE_DELAY ?? null,
    OTEL_EXPORTER_OTLP_ENDPOINT: redactEndpoint(config.OTEL_EXPORTER_OTLP_ENDPOINT),
    OTEL_EXPORTER_OTLP_HEADERS: redactHeaders(config.OTEL_EXPORTER_OTLP_HEADERS),
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: redactEndpoint(config.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT),
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: redactHeaders(config.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: config.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: config.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT ?? null,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: redactEndpoint(config.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT),
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: redactHeaders(config.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ?? null,
    OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: config.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT ?? null,
    OTEL_EXPORTER_OTLP_PROTOCOL: config.OTEL_EXPORTER_OTLP_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_TIMEOUT: config.OTEL_EXPORTER_OTLP_TIMEOUT ?? null,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: redactEndpoint(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT),
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: redactHeaders(config.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: config.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? null,
    OTEL_LOG_LEVEL: config.logLevel ?? null,
    OTEL_LOGS_EXPORTER: config.OTEL_LOGS_EXPORTER ?? null,
    OTEL_METRIC_EXPORT_INTERVAL: config.OTEL_METRIC_EXPORT_INTERVAL ?? null,
    OTEL_METRIC_EXPORT_TIMEOUT: config.OTEL_METRIC_EXPORT_TIMEOUT ?? null,
    OTEL_METRICS_EXPORTER: config.OTEL_METRICS_EXPORTER ?? null,
    OTEL_PROPAGATORS: config.tracePropagationStyle ?? null,
    OTEL_RESOURCE_ATTRIBUTES: config.OTEL_RESOURCE_ATTRIBUTES ?? {},
    OTEL_SDK_DISABLED: config.OTEL_SDK_DISABLED ?? null,
    OTEL_SERVICE_NAME: config.service ?? null,
    OTEL_TRACES_EXPORTER: config.OTEL_TRACES_EXPORTER ?? null,
    OTEL_TRACES_SAMPLER: config.OTEL_TRACES_SAMPLER ?? null,
    OTEL_TRACES_SAMPLER_ARG: config.OTEL_TRACES_SAMPLER_ARG ?? null,
    OTEL_TRACES_SPAN_METRICS_ENABLED: config.OTEL_TRACES_SPAN_METRICS_ENABLED ?? null,
  }
  if (config.tags?.version) startupLog.dd_version = config.tags.version
  return startupLog
}

/**
 * @param {string | undefined} endpoint
 */
function redactEndpoint (endpoint) {
  if (endpoint === undefined) return null

  // Credentials can use arbitrary query parameter names, independent of span obfuscation settings.
  endpoint = obfuscateQs({ queryStringObfuscation: true }, endpoint)
  if (!endpoint.includes('@')) return endpoint

  try {
    const url = new URL(endpoint)
    if (!url.username && !url.password) return endpoint
    if (url.username) url.username = 'REDACTED'
    if (url.password) url.password = 'REDACTED'
    return url.href
  } catch {
    // Do not expose potential credentials if a calculated endpoint cannot be parsed.
    return null
  }
}

/**
 * @param {Record<string, string> | undefined} headers
 */
function redactHeaders (headers) {
  // Header names must remain data even when they shadow object properties.
  /** @type {Record<string, string>} */
  const redacted = Object.create(null)
  if (headers) {
    for (const name of Object.keys(headers)) {
      redacted[name] = '<redacted>'
    }
  }
  return redacted
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
  logGenericError,
}
