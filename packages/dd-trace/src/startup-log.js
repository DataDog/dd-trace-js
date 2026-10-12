'use strict'

const os = require('os')
const { inspect } = require('util')

const tracerVersion = require('../../../package.json').version
const { isOtlpTraceEnabled } = require('./exporter')
const { redactEndpoint, redactHeaders } = require('./log/redact')
const { warn } = require('./log/writer')

const errors = {}
let config
/** @type {ReturnType<typeof otelConfig>} */
let otelStartupConfig
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
  /** @type {Record<string, unknown>} */
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
    DD_AGENT_HOST: config.hostname ?? null,
    DD_DATA_STREAMS_ENABLED: !!config.dsmEnabled,
    DD_DBM_PROPAGATION_MODE: config.dbmPropagationMode ?? null,
    DD_LOGS_OTEL_ENABLED: !!config.DD_LOGS_OTEL_ENABLED,
    DD_METRICS_OTEL_ENABLED: !!config.DD_METRICS_OTEL_ENABLED,
    DD_TRACE_OTEL_ENABLED: !!config.DD_TRACE_OTEL_ENABLED,
    DD_TRACE_OTEL_SEMANTICS_ENABLED: !!config.DD_TRACE_OTEL_SEMANTICS_ENABLED,
    DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: !!config.spanRemoveIntegrationFromService,
    ...otelStartupConfig,
  }
  if (config.tags?.version) startupLog.dd_version = config.tags.version
  return startupLog
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
 * @param {ReturnType<import('./config')>} aConfig
 */
function setStartupLogConfig (aConfig) {
  config = aConfig
  // OTel diagnostics describe initialization in both outputs; native diagnostics continue to read current Config.
  otelStartupConfig = otelConfig(aConfig, samplingRules)
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

/**
 * Project resolved settings and accepted sampling rules into diagnostic names.
 * Generic OTLP inputs have no single effective value across signals; report the resolved signal settings instead.
 * @param {ReturnType<import('./config')>} resolvedConfig
 * @param {import('./sampling_rule')[]} rules
 */
function otelConfig (resolvedConfig, rules) {
  const exportOtlpTraces = isOtlpTraceEnabled(resolvedConfig)
  // PrioritySampler appends the global rule after accepted custom rules and publishes the normalized list.
  const globalRule = resolvedConfig.sampler.sampleRate === undefined ? undefined : rules.at(-1)
  let samplerName
  let samplerArgument
  if (rules.length > (globalRule ? 1 : 0)) {
    samplerName = 'datadog_custom_rules'
  } else if (globalRule) {
    const rate = globalRule.sampleRate
    samplerName = rate === 0
      ? 'parentbased_always_off'
      : rate === 1 ? 'parentbased_always_on' : 'parentbased_traceidratio'
    if (samplerName === 'parentbased_traceidratio') samplerArgument = rate
  }

  return {
    otlp_traces_export_enabled: exportOtlpTraces,
    otlp_metrics_export_enabled: !!resolvedConfig.DD_METRICS_OTEL_ENABLED,
    otlp_logs_export_enabled: !!resolvedConfig.DD_LOGS_OTEL_ENABLED,
    // Preserve unset supported settings in JSON; unsupported inputs are omitted.
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: resolvedConfig.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ?? null,
    OTEL_BSP_MAX_QUEUE_SIZE: resolvedConfig.OTEL_BSP_MAX_QUEUE_SIZE ?? null,
    OTEL_BSP_SCHEDULE_DELAY: resolvedConfig.OTEL_BSP_SCHEDULE_DELAY ?? null,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: redactEndpoint(resolvedConfig.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT),
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: redactHeaders(resolvedConfig.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: resolvedConfig.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: resolvedConfig.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT ?? null,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: redactEndpoint(resolvedConfig.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT),
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: redactHeaders(resolvedConfig.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: resolvedConfig.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE:
      resolvedConfig.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ?? null,
    OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: resolvedConfig.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT ?? null,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: redactEndpoint(resolvedConfig.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT),
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: redactHeaders(resolvedConfig.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: resolvedConfig.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? null,
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: resolvedConfig.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? null,
    OTEL_LOG_LEVEL: resolvedConfig.logLevel ?? null,
    OTEL_LOGS_EXPORTER: resolvedConfig.DD_LOGS_OTEL_ENABLED ? 'otlp' : 'none',
    OTEL_METRIC_EXPORT_INTERVAL: resolvedConfig.OTEL_METRIC_EXPORT_INTERVAL ?? null,
    OTEL_METRICS_EXPORTER: resolvedConfig.DD_METRICS_OTEL_ENABLED ? 'otlp' : 'none',
    OTEL_PROPAGATORS: {
      inject: [...resolvedConfig.tracePropagationStyle?.inject ?? []],
      extract: [...resolvedConfig.tracePropagationStyle?.extract ?? []],
    },
    OTEL_RESOURCE_ATTRIBUTES: Object.fromEntries(
      Object.keys(resolvedConfig.OTEL_RESOURCE_ATTRIBUTES ?? {}).map(key => [key, resolvedConfig.tags[key]])
    ),
    OTEL_SERVICE_NAME: resolvedConfig.service ?? null,
    OTEL_TRACES_EXPORTER: exportOtlpTraces ? 'otlp' : 'none',
    OTEL_TRACES_SAMPLER: samplerName ?? null,
    OTEL_TRACES_SAMPLER_ARG: samplerArgument ?? null,
    OTEL_TRACES_SPAN_METRICS_ENABLED: resolvedConfig.OTEL_TRACES_SPAN_METRICS_ENABLED ?? null,
  }
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
