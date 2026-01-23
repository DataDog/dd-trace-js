'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('./send-data')

/**
 * RetryData is information that `telemetry.js` keeps in-memory to be merged into the next payload.
 *
 * @callback GetRetryData
 * @returns {{ payload: Record<string, unknown>, reqType: string } | null}
 */
/**
 * @typedef {import('./send-data').TelemetryConfig & {
 *   appsec?: { apiSecurity?: { endpointCollectionEnabled?: boolean, endpointCollectionMessageLimit?: number } }
 * }} TelemetryConfig
 */

const fastifyRouteCh = dc.channel('apm:fastify:route:added')
const expressRouteCh = dc.channel('apm:express:route:added')
const routerRouteCh = dc.channel('apm:router:route:added')

/** @type {TelemetryConfig} */
let config

/** @type {import('./send-data').TelemetryApplication} */
let application

/** @type {import('./send-data').TelemetryHost} */
let host

/** @type {GetRetryData} */
let getRetryData

/** @type {import('./send-data').SendDataCallback} */
let updateRetryData

/**
 * Keep track of endpoints that still need to be sent.
 * Map key is `${METHOD} ${PATH}`, value is { method, path, operationName }
 */
/** @type {Map<string, { method: string, path: string, operationName: string }>} */
const pendingEndpoints = new Map()

/** @type {Set<string>} */
const wildcardEndpoints = new Set()
let flushScheduled = false
let isFirstPayload = true

/**
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
function endpointKey (method, path) {
  return `${method.toUpperCase()} ${path}`
}

/**
 * @returns {void}
 */
function scheduleFlush () {
  if (flushScheduled) return
  flushScheduled = true
  // this used to be setImmediate() instead, but it was making the system test flaky
  // don't ask me why
  setTimeout(flushAndSend).unref()
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} operationName
 * @returns {void}
 */
function recordEndpoint (method, path, operationName) {
  const key = endpointKey(method, path)
  if (pendingEndpoints.has(key)) return

  pendingEndpoints.set(key, { method: method.toUpperCase(), path, operationName })
  scheduleFlush()
}

/**
 * @param {{ routeOptions?: { path?: string, method: string | string[] } } | null | undefined} routeData
 */
function onFastifyRoute (routeData) {
  const routeOptions = routeData?.routeOptions
  if (!routeOptions?.path) return

  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
  for (const method of methods) {
    recordEndpoint(method, routeOptions.path, 'fastify.request')
  }
}

/**
 * @param {{ method?: string, path?: string }} param0
 */
function onExpressRoute ({ method, path }) {
  if (!method || !path) return

  // If wildcard already recorded for this path, skip specific methods
  if (wildcardEndpoints.has(path)) return

  recordEndpoint(method, path, 'express.request')

  // If this is a wildcard event, record it and mark path as wildcarded
  if (method === '*') {
    wildcardEndpoints.add(path)
    return
  }

  // Express automatically adds HEAD support for GET routes
  if (method.toUpperCase() === 'GET') {
    recordEndpoint('HEAD', path, 'express.request')
  }
}

/**
 * @param {{ method: string, path: string, operationName: string }[]} endpoints
 */
function buildEndpointObjects (endpoints) {
  return endpoints.map(({ method, path, operationName }) => {
    return {
      type: 'REST',
      method,
      path,
      operation_name: operationName,
      resource_name: endpointKey(method, path)
    }
  })
}

/**
 * @returns {void}
 */
function flushAndSend () {
  flushScheduled = false
  if (pendingEndpoints.size === 0) return

  const batchEndpoints = []
  for (const [key, endpoint] of pendingEndpoints) {
    batchEndpoints.push(endpoint)
    pendingEndpoints.delete(key)
    // Config is set when endpoint collection is enabled; message limit is optional
    if (batchEndpoints.length >= (config.appsec?.apiSecurity?.endpointCollectionMessageLimit ?? 0)) break
  }

  const payloadObj = {
    is_first: isFirstPayload,
    endpoints: buildEndpointObjects(batchEndpoints)
  }

  /** @type {import('./send-data').TelemetryRequestType} */
  let reqType = 'app-endpoints'

  /** @type {import('./send-data').TelemetryPayload} */
  let payload = payloadObj

  const retryData = getRetryData()
  if (retryData) {
    payload = [
      { request_type: 'app-endpoints', payload: payloadObj },
      { request_type: retryData.reqType, payload: retryData.payload }
    ]
    reqType = 'message-batch'
  }

  sendData(config, application, host, reqType, payload, updateRetryData)

  if (isFirstPayload) {
    isFirstPayload = false
  }

  // If more endpoints accumulated while sending, schedule another flush.
  if (pendingEndpoints.size) scheduleFlush()
}

/**
 * @param {TelemetryConfig} _config
 * @param {import('./send-data').TelemetryApplication} _application
 * @param {import('./send-data').TelemetryHost} _host
 * @param {GetRetryData} getRetryDataFunction
 * @param {import('./send-data').SendDataCallback} updateRetryDataFunction
 */
function start (_config, _application, _host, getRetryDataFunction, updateRetryDataFunction) {
  if (!_config.appsec?.apiSecurity?.endpointCollectionEnabled) return

  config = _config
  application = _application
  host = _host
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDataFunction

  fastifyRouteCh.subscribe(onFastifyRoute)
  expressRouteCh.subscribe(onExpressRoute)
  routerRouteCh.subscribe(onExpressRoute)
}

function stop () {
  fastifyRouteCh.unsubscribe(onFastifyRoute)
  expressRouteCh.unsubscribe(onExpressRoute)
  routerRouteCh.unsubscribe(onExpressRoute)

  pendingEndpoints.clear()
  flushScheduled = false
}

module.exports = {
  start,
  stop
}
