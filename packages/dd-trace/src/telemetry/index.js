'use strict'
const tracerVersion = require('../../../../package.json').version
const dc = require('../../../diagnostics_channel')
const os = require('os')
const dependencies = require('./dependencies')
const { sendData } = require('./send-data')
const { errors } = require('../startup-log')
const { manager: metricsManager } = require('./metrics')

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryStopChannel = dc.channel('datadog:telemetry:stop')

let config
let pluginManager

let application
let host
let interval
let heartbeatTimeout
let heartbeatInterval
let extendedInterval
let integrations
let retryData = null

const sentIntegrations = new Set()

function updateRetryData (error, retryObj) {
  if (error) {
    if (retryObj.reqType === 'message-batch') {
      const payload = retryObj.payload[0].payload
      const reqType = retryObj.payload[0].request_type
      retryData = { payload: payload, reqType: reqType }
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
    'appsec': {
      'enabled': config.appsec.enabled
    },
    'profiler': {
      'version': tracerVersion,
      'enabled': config.profiling.enabled
    }
  }
  if (errors.profilingError) {
    products.profiler.error = errors.profilingError
    errors.profilingError = {}
  }
  return products
}

function flatten (input, result = [], prefix = [], traversedObjects = null) {
  traversedObjects = traversedObjects || new WeakSet()
  if (traversedObjects.has(input)) {
    return
  }
  traversedObjects.add(input)
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'object' && value !== null) {
      flatten(value, result, [...prefix, key], traversedObjects)
    } else {
      result.push({ name: [...prefix, key].join('.'), value })
    }
  }
  return result
}

function appStarted (config) {
  const app = {
    products: getProducts(config),
    configuration: flatten(config),
    additional_payload: []
  }
  if (errors.agentError) {
    app.error = errors.agentError
    errors.agentError = {}
  }
  return app
}

function formatConfig (config) {
// format peerServiceMapping from an object to a string map in order for
// telemetry intake to accept the configuration
  config.peerServiceMapping = config.peerServiceMapping
    ? Object.entries(config.peerServiceMapping).map(([key, value]) => `${key}:${value}`).join(',')
    : ''
  return config
}

function onBeforeExit () {
  process.removeListener('beforeExit', onBeforeExit)
  sendData(config, application, host, 'app-closing')
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
  const batchPayload = []
  payload.map(item => {
    batchPayload.push({
      'request_type': item.reqType,
      'payload': item.payload
    })
  })
  // eslint-disable-next-line no-console
  // console.log(batchPayload)

  return batchPayload
}

function heartbeat (config, application, host) {
  heartbeatTimeout = setTimeout(() => {
    metricsManager.send(config, application, host)
    sendData(config, application, host, 'app-heartbeat')
    heartbeat(config, application, host)
  }, heartbeatInterval).unref()
  return heartbeatTimeout
}

function extendedHeartbeat (config) {
  extendedInterval = setTimeout(() => {
    sendData(config, application, host, 'app-extendedHeartbeat', appStarted(config))
  }, 1000 * 60 * 60 * 24).unref()
  return extendedInterval
}

function start (aConfig, thePluginManager) {
  if (!aConfig.telemetry.enabled) {
    return
  }
  config = aConfig
  pluginManager = thePluginManager
  application = createAppObject(config)
  host = createHostObject()
  heartbeatInterval = config.telemetry.heartbeatInterval
  integrations = getIntegrations()

  dependencies.start(config, application, host)

  sendData(config, application, host, 'app-started', appStarted(config))

  sendData(config, application, host, 'app-integrations-change',
    { 'integrations': integrations }, updateRetryData)

  heartbeat(config, application, host)

  extendedHeartbeat(config)

  process.on('beforeExit', onBeforeExit)
  telemetryStartChannel.publish(getTelemetryData())
}

function stop () {
  if (!config) {
    return
  }
  clearInterval(interval)
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

  let currPayload
  if (retryData) {
    currPayload = { reqType: 'app-integrations-change', payload: { 'integrations': integrations } }
  } else {
    currPayload = { 'integrations': integrations }
  }

  const payload = retryData ? createBatchPayload([currPayload, retryData]) : currPayload
  const reqType = retryData ? 'message-batch' : 'app-integrations-change'

  sendData(config, application, host, reqType, payload, updateRetryData)
}

function updateConfig (changes, config) {
  if (!config.telemetry.enabled) return
  if (changes.length === 0) return

  // Hack to make system tests happy until we ship telemetry v2
  if (process.env.DD_INTERNAL_TELEMETRY_V2_ENABLED !== '1') return

  const application = createAppObject(config)
  const host = createHostObject()

  const names = {
    sampleRate: 'DD_TRACE_SAMPLE_RATE',
    logInjection: 'DD_LOG_INJECTION',
    headerTags: 'DD_TRACE_HEADER_TAGS'
  }

  const configuration = changes.map(change => ({
    name: names[change.name],
    value: Array.isArray(change.value) ? change.value.join(',') : change.value,
    origin: change.origin
  }))

  let currPayload
  if (retryData) {
    currPayload = { reqType: 'app-integrations-change', payload: { configuration } }
  } else {
    currPayload = { 'integrations': integrations }
  }

  const payload = retryData ? createBatchPayload([currPayload, retryData]) : currPayload
  const reqType = retryData ? 'message-batch' : 'app-integrations-change'

  sendData(config, application, host, reqType, payload, updateRetryData)
}

module.exports = {
  start,
  stop,
  updateIntegrations,
  updateConfig
}
