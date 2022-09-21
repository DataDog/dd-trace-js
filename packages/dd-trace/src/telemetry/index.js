'use strict'

const tracerVersion = require('../../../../package.json').version
const containerId = require('../exporters/common/docker').id()
const os = require('os')
const dependencies = require('./dependencies')
const { sendData } = require('./send-data')

const HB_INTERVAL = process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL ?
  Number(process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL) * 1000 :
  60000

let config
let pluginManager

let application
let host
let interval
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
    configuration: flatten(config),
    additional_payload: []
  }
}

function onBeforeExit () {
  process.removeListener('beforeExit', onBeforeExit)
  sendData(config, application, host, 'app-closing')
}

function createAppObject () {
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
  return {
    hostname: os.hostname(), // TODO is this enough?
    container_id: containerId
  }
}

function start (aConfig, thePluginManager) {
  if (!aConfig.telemetryEnabled) {
    return
  }
  config = aConfig
  pluginManager = thePluginManager
  application = createAppObject()
  host = createHostObject()
  dependencies.start(config, application, host)
  sendData(config, application, host, 'app-started', appStarted())
  interval = setInterval(() => sendData(config, application, host, 'app-heartbeat'), HB_INTERVAL)
  interval.unref()
  process.on('beforeExit', onBeforeExit)
}

function stop () {
  if (!config) {
    return
  }
  clearInterval(interval)
  process.removeListener('beforeExit', onBeforeExit)
}

function updateIntegrations () {
  if (!config || !config.telemetryEnabled) {
    return
  }
  const integrations = getIntegrations()
  if (integrations.length === 0) {
    return
  }
  sendData(config, application, host, 'app-integrations-change', { integrations })
}

module.exports = {
  start,
  stop,
  updateIntegrations
}
