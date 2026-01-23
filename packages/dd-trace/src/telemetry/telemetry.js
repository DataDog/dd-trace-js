'use strict'

const os = require('os')
const dc = require('dc-polyfill')

const tracerVersion = require('../../../../package.json').version
const { errors } = require('../startup-log')
const logger = require('../log')
const processTags = require('../process-tags')
const dependencies = require('./dependencies')
const endpoints = require('./endpoints')
const { sendData } = require('./send-data')
const { manager: metricsManager } = require('./metrics')
const telemetryLogger = require('./logs')

/**
 * @typedef {Record<string, unknown>} TelemetryPayloadObject
 */
/**
 * @typedef {string | number | boolean | null | undefined | URL | Record<string, unknown> | unknown[]} ConfigValue
 */
/**
 * @typedef {{
 *   name: string,
 *   enabled: boolean,
 *   auto_enabled: boolean,
 *   process_tags: typeof processTags.tagsObject
 * }} Integration
 */
/**
 * @typedef {{ _enabled: boolean }} Plugin
 */
/**
 * @typedef {{ _pluginsByName: Record<string, Plugin> }} PluginManager
 */
/**
 * @typedef {{
 *   service_name: string | undefined,
 *   env: string | undefined,
 *   service_version: string | undefined,
 *   tracer_version: string,
 *   language_name: 'nodejs',
 *   language_version: string
 *   process_tags: typeof processTags.tagsObject
 * }} TelemetryApplication
 */
/**
 * @typedef {{
 *   hostname: string,
 *   os: string,
 *   architecture: string,
 *   os_version?: string,
 *   kernel_version?: string,
 *   kernel_release?: string,
 *   kernel_name?: string
 * }} TelemetryHost
 */
/**
 * @typedef {{
 *   telemetry: {
 *     enabled: boolean,
 *     heartbeatInterval: number,
 *     debug?: boolean,
 *     dependencyCollection?: boolean,
 *     logCollection?: boolean
 *   },
 *   service: string | undefined,
 *   env: string | undefined,
 *   version: string | undefined,
 *   tags: Record<string, string>,
 *   url?: string | URL,
 *   hostname?: string,
 *   port?: string | number,
 *   site?: string,
 *   apiKey?: string,
 *   isCiVisibility?: boolean,
 *   spanAttributeSchema?: string,
 *   installSignature?: { id?: string, time?: string, type?: string },
 *   sca?: { enabled?: boolean },
 *   appsec: { enabled: boolean, apiSecurity?: {
 *     endpointCollectionEnabled?: boolean,
 *     endpointCollectionMessageLimit?: number
 *   } },
 *   profiling: { enabled: boolean | 'true' | 'false' | 'auto' }
 * }} TelemetryConfig
 */

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryStopChannel = dc.channel('datadog:telemetry:stop')
const telemetryAppClosingChannel = dc.channel('datadog:telemetry:app-closing')

/** @type {TelemetryConfig | undefined} */
let config

/** @type {PluginManager} */
let pluginManager

/** @type {TelemetryApplication} */
let application

/** @type {TelemetryHost} */
const host = createHostObject()

/** @type {ReturnType<typeof setInterval> | undefined} */
let heartbeatInterval

/** @type {ReturnType<typeof setInterval> | undefined} */
let extendedInterval

/** @type {Integration[]} */
let integrations

/** @type {Map<string, { name: string, value: ConfigValue, origin: string, seq_id: number }>} */
const configWithOrigin = new Map()

/**
 * Retry information that `telemetry.js` keeps in-memory to be merged into the next payload.
 *
 * @typedef {{ payload: TelemetryPayloadObject, reqType: string }} RetryData
 */
/** @type {{ payload: TelemetryPayloadObject, reqType: string } | null} */
let retryData = null

/** @type {TelemetryPayloadObject[]} */
let heartbeatFailedIntegrations = []

/** @type {TelemetryPayloadObject[]} */
let heartbeatFailedDependencies = []

const sentIntegrations = new Set()

let seqId = 0

function getRetryData () {
  return retryData
}

/**
 * @param {Error | null | undefined} error
 * @param {import('./send-data').SendDataRetryObject} retryObj
 */
function updateRetryData (error, retryObj) {
  if (!error) {
    retryData = null
    return
  }
  if (retryObj.reqType !== 'message-batch') {
    retryData = retryObj
    return
  }

  retryData = {
    payload: retryObj.payload[0].payload,
    reqType: retryObj.payload[0].request_type,
  }

  // Since this payload failed twice it now gets save in to the extended heartbeat
  const failedPayload = retryObj.payload[1].payload
  const failedReqType = retryObj.payload[1].request_type

  // save away the dependencies and integration request for extended heartbeat.
  if (failedReqType === 'app-integrations-change') {
    heartbeatFailedIntegrations.push(failedPayload)
  } else if (failedReqType === 'app-dependencies-loaded') {
    heartbeatFailedDependencies.push(failedPayload)
  }
}

function getIntegrations () {
  const newIntegrations = /** @type {Integration[]} */ ([])
  for (const pluginName of Object.keys(pluginManager._pluginsByName ?? {})) {
    if (!sentIntegrations.has(pluginName)) {
      newIntegrations.push({
        name: pluginName,
        enabled: pluginManager._pluginsByName[pluginName]._enabled,
        auto_enabled: true,
        [processTags.TELEMETRY_FIELD_NAME]: processTags.tagsObject
      })
      sentIntegrations.add(pluginName)
    }
  }
  return newIntegrations
}

/**
 * @param {TelemetryConfig} config
 */
function getProducts (config) {
  return {
    appsec: {
      enabled: config.appsec.enabled
    },
    profiler: {
      version: tracerVersion,
      enabled: profilingEnabledToBoolean(config.profiling.enabled)
    }
  }
}

/**
 * @param {TelemetryConfig} config
 */
function getInstallSignature (config) {
  const { installSignature: sig } = config
  if (sig && (sig.id || sig.time || sig.type)) {
    return {
      install_id: sig.id,
      install_time: sig.time,
      install_type: sig.type
    }
  }
}

/**
 * @param {TelemetryConfig} config
 */
function appStarted (config) {
  const app = {
    products: getProducts(config),
    configuration: [...configWithOrigin.values()]
  }
  const installSignature = getInstallSignature(config)
  if (installSignature) {
    app.install_signature = installSignature
  }
  if (errors.agentError) {
    app.error = errors.agentError
    errors.agentError = undefined
  }
  return app
}

function appClosing () {
  if (!config?.telemetry?.enabled) {
    return
  }
  // Give chance to listeners to update metrics before shutting down.
  telemetryAppClosingChannel.publish()
  const { reqType, payload } = createPayload('app-closing')
  sendData(config, application, host, reqType, payload)
  // We flush before shutting down.
  metricsManager.send(config, application, host)
  telemetryLogger.send(config, application, host)
}

/**
 * @param {TelemetryConfig} config
 * @returns {TelemetryApplication}
 */
function createAppObject (config) {
  return {
    service_name: config.service,
    env: config.env,
    service_version: config.version,
    tracer_version: tracerVersion,
    language_name: 'nodejs',
    language_version: process.versions.node,
    process_tags: processTags.tagsObject
  }
}

/**
 * @returns {TelemetryHost}
 */
function createHostObject () {
  const osName = os.type()
  const base = {
    hostname: os.hostname(),
    os: osName,
    architecture: os.arch(),
  }

  if (os.platform() === 'win32') {
    base.os_version = os.version() // Optional
  } else {
    base.kernel_version = os.version()
    base.kernel_release = os.release()
    base.kernel_name = osName
  }

  return base
}

function getTelemetryData () {
  return { config, application, host, heartbeatInterval: config?.telemetry.heartbeatInterval }
}

/**
 * @param {{ reqType: string, payload: TelemetryPayloadObject }[]} payload
 */
function createBatchPayload (payload) {
  return payload.map(item => {
    return {
      request_type: item.reqType,
      payload: item.payload
    }
  })
}

/**
 * @param {import('./send-data').NonBatchTelemetryRequestType} currReqType
 * @param {TelemetryPayloadObject} [currPayload]
 * @returns {{
 *   reqType: 'message-batch',
 *   payload: import('./send-data').MessageBatchPayload
 * } | {
 *   reqType: import('./send-data').NonBatchTelemetryRequestType,
 *   payload: TelemetryPayloadObject
 * }}
 */
function createPayload (currReqType, currPayload = {}) {
  if (getRetryData()) {
    const payload = { reqType: currReqType, payload: currPayload }
    const batchPayload = createBatchPayload([payload, retryData])
    return { reqType: 'message-batch', payload: batchPayload }
  }

  return { reqType: currReqType, payload: currPayload }
}

/**
 * @param {TelemetryConfig} config
 * @param {TelemetryApplication} application
 */
function heartbeat (config, application) {
  heartbeatInterval = setInterval(() => {
    metricsManager.send(config, application, host)
    telemetryLogger.send(config, application, host)

    const { reqType, payload } = createPayload('app-heartbeat')
    sendData(config, application, host, reqType, payload, updateRetryData)
  }, config.telemetry.heartbeatInterval).unref()
}

/**
 * @param {TelemetryConfig} config
 */
function extendedHeartbeat (config) {
  extendedInterval = setInterval(() => {
    const appPayload = appStarted(config)
    if (heartbeatFailedIntegrations.length > 0) {
      appPayload.integrations = heartbeatFailedIntegrations
      heartbeatFailedIntegrations = []
    }
    if (heartbeatFailedDependencies.length > 0) {
      appPayload.dependencies = heartbeatFailedDependencies
      heartbeatFailedDependencies = []
    }
    sendData(config, application, host, 'app-extended-heartbeat', appPayload)
  }, 1000 * 60 * 60 * 24).unref()
}

/**
 * @param {TelemetryConfig} aConfig
 * @param {PluginManager} thePluginManager
 */
function start (aConfig, thePluginManager) {
  if (!aConfig.telemetry.enabled) {
    if (aConfig.sca?.enabled) {
      logger.warn('DD_APPSEC_SCA_ENABLED requires enabling telemetry to work.')
    }

    return
  }
  config = aConfig
  pluginManager = thePluginManager
  application = createAppObject(config)
  integrations = getIntegrations()

  dependencies.start(config, application, host, getRetryData, updateRetryData)
  telemetryLogger.start(config)
  endpoints.start(config, application, host, getRetryData, updateRetryData)

  sendData(config, application, host, 'app-started', appStarted(config))

  if (integrations.length > 0) {
    sendData(config, application, host, 'app-integrations-change',
      { integrations }, updateRetryData)
  }

  heartbeat(config, application)

  extendedHeartbeat(config)

  globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(appClosing)
  telemetryStartChannel.publish(getTelemetryData())
}

function stop () {
  if (!config) {
    return
  }
  clearInterval(extendedInterval)
  clearInterval(heartbeatInterval)
  globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(appClosing)

  telemetryStopChannel.publish(getTelemetryData())

  endpoints.stop()
  config = undefined
}

function updateIntegrations () {
  if (!config?.telemetry.enabled) {
    return
  }
  const integrations = getIntegrations()
  if (integrations.length === 0) {
    return
  }

  const { reqType, payload } = createPayload('app-integrations-change', { integrations })

  sendData(config, application, host, reqType, payload, updateRetryData)
}

/**
 * @param {Record<string, string | number | boolean> | null | undefined} map
 */
function formatMapForTelemetry (map) {
  // format from an object to a string map in order for
  // telemetry intake to accept the configuration
  return map
    ? Object.entries(map).map(([key, value]) => `${key}:${value}`).join(',')
    : ''
}

const nameMapping = {
  sampleRate: 'DD_TRACE_SAMPLE_RATE',
  logInjection: 'DD_LOG_INJECTION',
  headerTags: 'DD_TRACE_HEADER_TAGS',
  tags: 'DD_TAGS',
  'sampler.rules': 'DD_TRACE_SAMPLING_RULES',
  traceEnabled: 'DD_TRACE_ENABLED',
  url: 'DD_TRACE_AGENT_URL',
  'sampler.rateLimit': 'DD_TRACE_RATE_LIMIT',
  queryStringObfuscation: 'DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP',
  version: 'DD_VERSION',
  env: 'DD_ENV',
  service: 'DD_SERVICE',
  clientIpHeader: 'DD_TRACE_CLIENT_IP_HEADER',
  'grpc.client.error.statuses': 'DD_GRPC_CLIENT_ERROR_STATUSES',
  'grpc.server.error.statuses': 'DD_GRPC_SERVER_ERROR_STATUSES',
  traceId128BitLoggingEnabled: 'DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED',
  instrumentationSource: 'instrumentation_source',
  injectionEnabled: 'ssi_injection_enabled',
  injectForce: 'ssi_forced_injection_enabled',
  'runtimeMetrics.enabled': 'runtimeMetrics',
  otelLogsEnabled: 'DD_LOGS_OTEL_ENABLED',
  otelUrl: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  otelEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  otelHeaders: 'OTEL_EXPORTER_OTLP_HEADERS',
  otelProtocol: 'OTEL_EXPORTER_OTLP_PROTOCOL',
  otelTimeout: 'OTEL_EXPORTER_OTLP_TIMEOUT',
  otelLogsHeaders: 'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  otelLogsProtocol: 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  otelLogsTimeout: 'OTEL_EXPORTER_OTLP_LOGS_TIMEOUT',
  otelLogsUrl: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  otelBatchTimeout: 'OTEL_BSP_SCHEDULE_DELAY',
  otelMaxExportBatchSize: 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
  otelMaxQueueSize: 'OTEL_BSP_MAX_QUEUE_SIZE',
  otelMetricsEnabled: 'DD_METRICS_OTEL_ENABLED',
  otelMetricsHeaders: 'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  otelMetricsProtocol: 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  otelMetricsTimeout: 'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT',
  otelMetricsExportTimeout: 'OTEL_METRIC_EXPORT_TIMEOUT',
  otelMetricsUrl: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  otelMetricsExportInterval: 'OTEL_METRIC_EXPORT_INTERVAL',
  otelMetricsTemporalityPreference: 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
}

const namesNeedFormatting = new Set(['DD_TAGS', 'peerServiceMapping', 'serviceMapping'])

/**
 * @param {{ name: string, value: ConfigValue, origin: string }[]} changes
 * @param {TelemetryConfig} config
 */
function updateConfig (changes, config) {
  if (!config.telemetry.enabled) return
  if (changes.length === 0) return

  logger.trace(changes)

  const application = createAppObject(config)

  const changed = configWithOrigin.size > 0

  for (const change of changes) {
    const name = nameMapping[change.name] || change.name
    const { origin, value } = change
    const entry = { name, value, origin, seq_id: seqId++ }

    if (namesNeedFormatting.has(name)) {
      // @ts-expect-error entry.value is known to be a map for these config names
      entry.value = formatMapForTelemetry(value)
    } else if (name === 'url') {
      if (value) {
        entry.value = value.toString()
      }
    } else if (name === 'DD_TRACE_SAMPLING_RULES') {
      entry.value = JSON.stringify(value)
    } else if (Array.isArray(value)) {
      entry.value = value.join(',')
    }

    // Use composite key to support multiple origins for same config name
    configWithOrigin.set(`${name}|${origin}`, entry)
  }

  if (changed) {
    // update configWithOrigin to contain up-to-date full list of config values for app-extended-heartbeat
    const { reqType, payload } = createPayload('app-client-configuration-change', {
      configuration: [...configWithOrigin.values()]
    })
    sendData(config, application, host, reqType, payload, updateRetryData)
  }
}

/**
 * @param {TelemetryConfig['profiling']['enabled']} profilingEnabled
 */
function profilingEnabledToBoolean (profilingEnabled) {
  if (typeof profilingEnabled === 'boolean') {
    return profilingEnabled
  }
  return profilingEnabled === 'true' || profilingEnabled === 'auto'
}

module.exports = {
  start,
  stop,
  updateIntegrations,
  updateConfig,
  appClosing
}
