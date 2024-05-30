'use strict'
const tracerVersion = require('../../../../package.json').version
const dc = require('dc-polyfill')
const os = require('os')
const dependencies = require('./dependencies')
const { sendData } = require('./send-data')
const { errors } = require('../startup-log')
const { manager: metricsManager } = require('./metrics')
const telemetryLogger = require('./logs')
const logger = require('../log')

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryStopChannel = dc.channel('datadog:telemetry:stop')
const telemetryAppClosingChannel = dc.channel('datadog:telemetry:app-closing')

let config
let pluginManager

let application
let host
let heartbeatTimeout
let heartbeatInterval
let extendedInterval
let integrations
let configWithOrigin = []
let retryData = null
const extendedHeartbeatPayload = {}

const sentIntegrations = new Set()

function getRetryData () {
  return retryData
}

function updateRetryData (error, retryObj) {
  if (error) {
    if (retryObj.reqType === 'message-batch') {
      const payload = retryObj.payload[0].payload
      const reqType = retryObj.payload[0].request_type
      retryData = { payload, reqType }

      // Since this payload failed twice it now gets save in to the extended heartbeat
      const failedPayload = retryObj.payload[1].payload
      const failedReqType = retryObj.payload[1].request_type

      // save away the dependencies and integration request for extended heartbeat.
      if (failedReqType === 'app-integrations-change') {
        if (extendedHeartbeatPayload.integrations) {
          extendedHeartbeatPayload.integrations.push(failedPayload)
        } else {
          extendedHeartbeatPayload.integrations = [failedPayload]
        }
      }
      if (failedReqType === 'app-dependencies-loaded') {
        if (extendedHeartbeatPayload.dependencies) {
          extendedHeartbeatPayload.dependencies.push(failedPayload)
        } else {
          extendedHeartbeatPayload.dependencies = [failedPayload]
        }
      }
    } else {
      retryData = retryObj
    }
  } else {
    retryData = null
  }
}

function getIntegrations () {
  const newIntegrations = []
  for (const pluginName in pluginManager._pluginsByName) {
    if (sentIntegrations.has(pluginName)) {
      continue
    }
    newIntegrations.push({
      name: pluginName,
      enabled: pluginManager._pluginsByName[pluginName]._enabled,
      auto_enabled: true
    })
    sentIntegrations.add(pluginName)
  }
  return newIntegrations
}

function getProducts (config) {
  const products = {
    appsec: {
      enabled: config.appsec.enabled
    },
    profiler: {
      version: tracerVersion,
      enabled: config.profiling.enabled
    }
  }
  if (errors.profilingError) {
    products.profiler.error = errors.profilingError
    errors.profilingError = {}
  }
  return products
}

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

function appStarted (config) {
  const app = {
    products: getProducts(config),
    configuration: configWithOrigin
  }
  const installSignature = getInstallSignature(config)
  if (installSignature) {
    app.install_signature = installSignature
  }
  // TODO: add app.error with correct error codes
  // if (errors.agentError) {
  //   app.error = errors.agentError
  //   errors.agentError = {}
  // }
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
}

function onBeforeExit () {
  process.removeListener('beforeExit', onBeforeExit)
  appClosing()
}

function createAppObject (config) {
  return {
    service_name: config.service,
    env: config.env,
    service_version: config.version,
    tracer_version: tracerVersion,
    language_name: 'nodejs',
    language_version: process.versions.node
  }
}

function createHostObject () {
  const osName = os.type()

  if (osName === 'Linux' || osName === 'Darwin') {
    return {
      hostname: os.hostname(),
      os: osName,
      architecture: os.arch(),
      kernel_version: os.version(),
      kernel_release: os.release(),
      kernel_name: osName
    }
  }

  if (osName === 'Windows_NT') {
    return {
      hostname: os.hostname(),
      os: osName,
      architecture: os.arch(),
      os_version: os.version()
    }
  }

  return {
    hostname: os.hostname(), // TODO is this enough?
    os: osName
  }
}

function getTelemetryData () {
  return { config, application, host, heartbeatInterval }
}

function createBatchPayload (payload) {
  const batchPayload = payload.map(item => {
    return {
      request_type: item.reqType,
      payload: item.payload
    }
  })

  return batchPayload
}

function createPayload (currReqType, currPayload = {}) {
  if (getRetryData()) {
    const payload = { reqType: currReqType, payload: currPayload }
    const batchPayload = createBatchPayload([payload, retryData])
    return { reqType: 'message-batch', payload: batchPayload }
  }

  return { reqType: currReqType, payload: currPayload }
}

function heartbeat (config, application, host) {
  heartbeatTimeout = setTimeout(() => {
    metricsManager.send(config, application, host)
    telemetryLogger.send(config, application, host)

    const { reqType, payload } = createPayload('app-heartbeat')
    sendData(config, application, host, reqType, payload, updateRetryData)
    heartbeat(config, application, host)
  }, heartbeatInterval).unref()
  return heartbeatTimeout
}

function extendedHeartbeat (config) {
  extendedInterval = setInterval(() => {
    const appPayload = appStarted(config)
    const payload = {
      ...appPayload,
      ...extendedHeartbeatPayload
    }
    sendData(config, application, host, 'app-extended-heartbeat', payload)
    Object.keys(extendedHeartbeatPayload).forEach(key => delete extendedHeartbeatPayload[key])
  }, 1000 * 60 * 60 * 24).unref()
  return extendedInterval
}

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
  host = createHostObject()
  heartbeatInterval = config.telemetry.heartbeatInterval
  integrations = getIntegrations()

  dependencies.start(config, application, host, getRetryData, updateRetryData)
  telemetryLogger.start(config)

  sendData(config, application, host, 'app-started', appStarted(config))

  if (integrations.length > 0) {
    sendData(config, application, host, 'app-integrations-change',
      { integrations }, updateRetryData)
  }

  heartbeat(config, application, host)

  extendedHeartbeat(config)

  process.on('beforeExit', onBeforeExit)
  telemetryStartChannel.publish(getTelemetryData())
}

function stop () {
  if (!config) {
    return
  }
  clearInterval(extendedInterval)
  clearTimeout(heartbeatTimeout)
  process.removeListener('beforeExit', onBeforeExit)

  telemetryStopChannel.publish(getTelemetryData())

  config = undefined
}

function updateIntegrations () {
  if (!config || !config.telemetry.enabled) {
    return
  }
  const integrations = getIntegrations()
  if (integrations.length === 0) {
    return
  }

  const { reqType, payload } = createPayload('app-integrations-change', { integrations })

  sendData(config, application, host, reqType, payload, updateRetryData)
}

function formatMapForTelemetry (map) {
  // format from an object to a string map in order for
  // telemetry intake to accept the configuration
  return map
    ? Object.entries(map).map(([key, value]) => `${key}:${value}`).join(',')
    : ''
}

function updateConfig (changes, config) {
  if (!config.telemetry.enabled) return
  if (changes.length === 0) return

  const application = createAppObject(config)
  const host = createHostObject()

  const nameMapping = {
    sampleRate: 'DD_TRACE_SAMPLE_RATE',
    logInjection: 'DD_LOG_INJECTION',
    headerTags: 'DD_TRACE_HEADER_TAGS',
    tags: 'DD_TAGS',
    'sampler.rules': 'DD_TRACE_SAMPLING_RULES'
  }

  const namesNeedFormatting = new Set(['DD_TAGS', 'peerServiceMapping'])

  const configuration = []
  const names = [] // list of config names whose values have been changed

  for (const change of changes) {
    const name = nameMapping[change.name] || change.name

    names.push(name)
    const { origin, value } = change
    const entry = { name, value, origin }

    if (namesNeedFormatting.has(entry.name)) entry.value = formatMapForTelemetry(entry.value)
    if (entry.name === 'url' && entry.value) entry.value = entry.value.toString()
    if (entry.name === 'DD_TRACE_SAMPLING_RULES') {
      entry.value = JSON.stringify(entry.value)
    }
    if (Array.isArray(entry.value)) entry.value = value.join(',')

    configuration.push(entry)
  }

  function isNotModified (entry) {
    return !names.includes(entry.name)
  }

  if (!configWithOrigin.length) {
    configWithOrigin = configuration
  } else {
    // update configWithOrigin to contain up-to-date full list of config values for app-extended-heartbeat
    configWithOrigin = configWithOrigin.filter(isNotModified)
    configWithOrigin = configWithOrigin.concat(configuration)
    const { reqType, payload } = createPayload('app-client-configuration-change', { configuration })
    sendData(config, application, host, reqType, payload, updateRetryData)
  }
}

module.exports = {
  start,
  stop,
  updateIntegrations,
  updateConfig,
  appClosing
}
