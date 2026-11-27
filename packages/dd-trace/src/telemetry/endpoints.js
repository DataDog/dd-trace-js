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
 *   appsec: {
 *     DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED: boolean,
 *     DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT: number
 *   }
 * }} TelemetryConfig
 */

const fastifyRouteCh = dc.channel('apm:fastify:route:added')
const expressRouteCh = dc.channel('apm:express:route:added')
const routerRouteCh = dc.channel('apm:router:route:added')
const nextRouteCh = dc.channel('apm:next:route:added')

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
 */
function endpointKey (method, path) {
  return `${method.toUpperCase()} ${path}`
}

function scheduleFlush () {
  if (flushScheduled) return
  flushScheduled = true
  // this used to be setImmediate() instead, but it was making the system test flaky
  // don't ask me why
  setTimeout(flushAndSend).unref?.()
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} operationName
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
  // If wildcard already recorded for this path, skip specific methods
  if (!method || !path || wildcardEndpoints.has(path)) return

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

const NEXT_HANDLER_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH']
const NEXT_INTERNAL_PAGE = /^\/(?:_|404$|500$)/
const NEXT_PAGES_API = /^\/api(?:\/|$)/

/**
 * Next.js paths already recorded: `false` for a `*` placeholder, `true` once the exported methods are known.
 *
 * @type {Map<string, boolean>}
 */
const nextRoutes = new Map()

/**
 * @param {unknown} userland
 * @returns {string[]}
 */
function getNextHandlerMethods (userland) {
  if (userland === null || (typeof userland !== 'object' && typeof userland !== 'function')) return []

  const methods = NEXT_HANDLER_METHODS.filter(method => typeof userland[method] === 'function')
  // Next.js answers HEAD with the GET handler when the module does not export HEAD.
  if (methods[0] === 'GET' && methods[1] !== 'HEAD') methods.splice(1, 0, 'HEAD')
  return methods
}

/**
 * Maps a Next.js page or route module to its endpoints. Pages use their manifest key, because Pages API routes and
 * static pages load without a route module; app entries use their route path. A route handler whose module is not
 * loaded yet (Next.js 16) is recorded as `*` until its exported methods arrive.
 *
 * @param {{ page?: unknown, isAppPath?: unknown, kind?: unknown, pathname?: unknown, userland?: unknown } | null} route
 */
function onNextRoute (route) {
  if (route === null || typeof route !== 'object') return

  const isAppPath = route.isAppPath === true
  const isRouteHandler = isAppPath && route.kind === 'APP_ROUTE'
  const path = isAppPath ? route.pathname : route.page
  if (typeof path !== 'string' || NEXT_INTERNAL_PAGE.test(path) || nextRoutes.get(path) === true) return

  let methods
  try {
    methods = isRouteHandler ? getNextHandlerMethods(route.userland) : []
  } catch {
    methods = []
  }

  if (methods.length > 0) {
    nextRoutes.set(path, true)
    pendingEndpoints.delete(endpointKey('*', path))
  } else {
    if (nextRoutes.has(path)) return
    nextRoutes.set(path, false)
    methods = isRouteHandler || (!isAppPath && NEXT_PAGES_API.test(path)) ? ['*'] : ['GET', 'HEAD']
  }

  for (const method of methods) {
    recordEndpoint(method, path, 'next.request')
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
      resource_name: endpointKey(method, path),
    }
  })
}

function flushAndSend () {
  flushScheduled = false
  if (pendingEndpoints.size === 0) return

  const batchEndpoints = []
  for (const [key, endpoint] of pendingEndpoints) {
    batchEndpoints.push(endpoint)
    pendingEndpoints.delete(key)
    if (batchEndpoints.length >= config.appsec.DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT) break
  }

  const payloadObj = {
    is_first: isFirstPayload,
    endpoints: buildEndpointObjects(batchEndpoints),
  }

  /** @type {import('./send-data').TelemetryRequestType} */
  let reqType = 'app-endpoints'

  /** @type {import('./send-data').TelemetryPayload} */
  let payload = payloadObj

  const retryData = getRetryData()
  if (retryData) {
    payload = [
      { request_type: 'app-endpoints', payload: payloadObj },
      { request_type: retryData.reqType, payload: retryData.payload },
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
  if (!_config.appsec.DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED) return

  config = _config
  application = _application
  host = _host
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDataFunction

  fastifyRouteCh.subscribe(onFastifyRoute)
  expressRouteCh.subscribe(onExpressRoute)
  routerRouteCh.subscribe(onExpressRoute)
  nextRouteCh.subscribe(onNextRoute)
}

function stop () {
  fastifyRouteCh.unsubscribe(onFastifyRoute)
  expressRouteCh.unsubscribe(onExpressRoute)
  routerRouteCh.unsubscribe(onExpressRoute)
  nextRouteCh.unsubscribe(onNextRoute)

  pendingEndpoints.clear()
  nextRoutes.clear()
  flushScheduled = false
}

module.exports = {
  start,
  stop,
}
