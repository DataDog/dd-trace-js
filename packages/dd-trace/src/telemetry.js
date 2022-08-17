'use strict'

const tracerVersion = require('../../../package.json').version
const pkg = require('./pkg')
const containerId = require('./exporters/common/docker').id()
const requirePackageJson = require('./require-package-json')
const path = require('path')
const os = require('os')
const request = require('./exporters/common/request')

let config
let pluginManager

let seqId = 0
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

function getDependencies () {
  const deps = []
  const { dependencies } = pkg
  if (!dependencies) {
    return deps
  }
  const rootDir = pkg.findRoot()
  for (const [name, version] of Object.entries(dependencies)) {
    const dep = { name }
    try {
      dep.version = requirePackageJson(
        path.join(rootDir, 'node_modules', name.replace('/', path.sep))
      ).version
    } catch (e) {
      dep.version = version
    }
    deps.push(dep)
  }
  return deps
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
    dependencies: getDependencies(),
    configuration: flatten(config),
    additional_payload: []
  }
}

function onBeforeExit () {
  process.removeListener('beforeExit', onBeforeExit)
  sendData('app-closing')
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

function sendData (reqType, payload = {}) {
  const {
    hostname,
    port
  } = config
  const options = {
    hostname,
    port,
    method: 'POST',
    path: '/telemetry/proxy/api/v2/apmtelemetry',
    headers: {
      'content-type': 'application/json',
      'dd-telemetry-api-version': 'v1',
      'dd-telemetry-request-type': reqType
    }
  }
  const data = JSON.stringify({
    api_version: 'v1',
    request_type: reqType,
    tracer_time: Math.floor(Date.now() / 1000),
    runtime_id: config.tags['runtime-id'],
    seq_id: ++seqId,
    payload,
    application,
    host
  })

  request(data, options, true, () => {
    // ignore errors
  })
}

function start (aConfig, thePluginManager) {
  if (!aConfig.telemetryEnabled) {
    return
  }
  config = aConfig
  pluginManager = thePluginManager
  application = createAppObject()
  host = createHostObject()
  sendData('app-started', appStarted())
  interval = setInterval(() => sendData('app-heartbeat'), 60000)
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
  sendData('app-integrations-change', { integrations })
}

module.exports = {
  start,
  stop,
  updateIntegrations
}
