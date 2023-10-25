'use strict'

const tracerVersion = require('../../../../package.json').version
const dc = require('../../../diagnostics_channel')
const os = require('os')
const dependencies = require('./dependencies')
const { sendData } = require('./send-data')

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
const sentIntegrations = new Set()

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

function appStarted () {
  return {
    integrations: getIntegrations(),
    dependencies: [],
    configuration: flatten(formatConfig(config)),
    additional_payload: []
  }
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

function heartbeat (config, application, host) {
  heartbeatTimeout = setTimeout(() => {
    sendData(config, application, host, 'app-heartbeat')
    heartbeat(config, application, host)
  }, heartbeatInterval).unref()
  return heartbeatTimeout
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

  dependencies.start(config, application, host)
  sendData(config, application, host, 'app-started', appStarted())
  heartbeat(config, application, host)
  interval = setInterval(() => {
    metricsManager.send(config, application, host)
  }, heartbeatInterval)
  interval.unref()
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
  sendData(config, application, host, 'app-integrations-change', { integrations })
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

  sendData(config, application, host, 'app-client-configuration-change', {
    configuration
  })
}

module.exports = {
  start,
  stop,
  updateIntegrations,
  updateConfig
}
