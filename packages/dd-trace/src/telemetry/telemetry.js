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
const sessionPropagation = require('./session-propagation')

/**
 * @typedef {Record<string, unknown>} TelemetryPayloadObject
 */
/**
 * @typedef {string | number | boolean | null | URL | Record<string, unknown> | unknown[] | Function} ConfigValue
 */
/**
 * @typedef {{ [K in keyof processTags]: typeof processTags.tagsObject[K] }} ProcessTags
 */
/**
 * @typedef {{
 *   name: string,
 *   enabled: boolean,
 *   auto_enabled: boolean,
 * } & Partial<ProcessTags>} Integration
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

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryAppClosingChannel = dc.channel('datadog:telemetry:app-closing')

/** @type {import('../config/config-base') | undefined} */
let config

/** @type {PluginManager} */
let pluginManager

/** @type {TelemetryApplication} */
let application

/** @type {TelemetryHost} */
const host = createHostObject()

/** @type {Integration[]} */
let integrations

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
        [processTags.TELEMETRY_FIELD_NAME]: processTags.tagsObject,
      })
      sentIntegrations.add(pluginName)
    }
  }
  return newIntegrations
}

/**
 * @param {import('../config/config-base')} config
 */
function getProducts (config) {
  return {
    appsec: {
      enabled: config.appsec.enabled,
    },
    profiler: {
      version: tracerVersion,
      enabled: profilingEnabledToBoolean(config.profiling.enabled),
    },
  }
}

/**
 * @param {import('../config/config-base')} config
 */
function getInstallSignature (config) {
  const { installSignature: sig } = config
  if (sig && (sig.id || sig.time || sig.type)) {
    return {
      install_id: sig.id,
      install_time: sig.time,
      install_type: sig.type,
    }
  }
}

/** @param {import('../config/config-base')} config */
function appStarted (config) {
  const app = {
    products: getProducts(config),
    configuration: latestConfiguration,
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
 * @param {import('../config/config-base')} config
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
    process_tags: processTags.tagsObject,
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
      payload: item.payload,
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
 * @param {import('../config/config-base')} config
 * @param {TelemetryApplication} application
 */
function heartbeat (config, application) {
  setInterval(() => {
    metricsManager.send(config, application, host)
    telemetryLogger.send(config, application, host)

    const { reqType, payload } = createPayload('app-heartbeat')
    sendData(config, application, host, reqType, payload, updateRetryData)
  }, config.telemetry.heartbeatInterval).unref()
}

/** @param {import('../config/config-base')} config */
function extendedHeartbeat (config) {
  setInterval(() => {
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
  }, config.telemetry.extendedHeartbeatInterval).unref()
}

/**
 * @param {import('../config/config-base')} aConfig
 * @param {PluginManager} thePluginManager
 */
function start (aConfig, thePluginManager) {
  if (!aConfig.telemetry.enabled) {
    if (aConfig.appsec.sca.enabled) {
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
  sessionPropagation.start(config)

  sendData(config, application, host, 'app-started', appStarted(config))

  if (integrations.length > 0) {
    sendData(config, application, host, 'app-integrations-change', { integrations }, updateRetryData)
  }

  heartbeat(config, application)

  extendedHeartbeat(config)

  globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(appClosing)
  telemetryStartChannel.publish(getTelemetryData())
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

let latestConfiguration = []

/**
 * @param {{ name: string, value: ConfigValue, origin: string, seq_id: number }[]} configuration
 * @param {import('../config/config-base')} config
 */
function updateConfig (configuration, config) {
  if (!config.telemetry.enabled) return

  logger.trace(configuration)

  const application = createAppObject(config)

  if (latestConfiguration.length) {
    const { reqType, payload } = createPayload('app-client-configuration-change', {
      configuration,
    })
    sendData(config, application, host, reqType, payload, updateRetryData)
  }
  latestConfiguration = configuration
}

/**
 * @param {import('../config/config-base')['profiling']['enabled']} profilingEnabled
 */
function profilingEnabledToBoolean (profilingEnabled) {
  return profilingEnabled === 'true' || profilingEnabled === 'auto'
}

module.exports = {
  start,
  updateIntegrations,
  updateConfig,
  appClosing,
}
