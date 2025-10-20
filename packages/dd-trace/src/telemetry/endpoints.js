'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('./send-data')

const fastifyRouteCh = dc.channel('apm:fastify:route:added')
const expressRouteCh = dc.channel('apm:express:route:added')

let config
let application
let host
let getRetryData
let updateRetryData

/**
 * Keep track of endpoints that still need to be sent.
 * Map key is `${METHOD} ${PATH}`, value is { method, path }
 */
const pendingEndpoints = new Map()
const wildcardEndpoints = new Set()
let flushScheduled = false
let isFirstPayload = true

function endpointKey (method, path) {
  return `${method.toUpperCase()} ${path}`
}

function scheduleFlush () {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(flushAndSend).unref()
}

function recordEndpoint (method, path) {
  const key = endpointKey(method, path)
  if (pendingEndpoints.has(key)) return

  pendingEndpoints.set(key, { method: method.toUpperCase(), path })
  scheduleFlush()
}

function onFastifyRoute (routeData) {
  const routeOptions = routeData?.routeOptions
  if (!routeOptions?.path) return

  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
  for (const method of methods) {
    recordEndpoint(method, routeOptions.path)
  }
}

function onExpressRoute ({ method, path }) {
  if (!method || !path) return

  // If wildcard already recorded for this path, skip specific methods
  if (wildcardEndpoints.has(path)) return

  recordEndpoint(method, path)

  // If this is a wildcard event, record it and mark path as wildcarded
  if (method === '*') {
    wildcardEndpoints.add(path)
    return
  }

  // Express automatically adds HEAD support for GET routes
  if (method.toUpperCase() === 'GET') {
    recordEndpoint('HEAD', path)
  }
}

function buildEndpointObjects (endpoints) {
  return endpoints.map(({ method, path }) => {
    return {
      type: 'REST',
      method,
      path,
      operation_name: 'http.request',
      resource_name: endpointKey(method, path)
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
    if (batchEndpoints.length >= config.appsec?.apiSecurity?.endpointCollectionMessageLimit) break
  }

  const payloadObj = {
    is_first: isFirstPayload,
    endpoints: buildEndpointObjects(batchEndpoints)
  }

  let reqType = 'app-endpoints'
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

function start (_config = {}, _application, _host, getRetryDataFunction, updateRetryDataFunction) {
  if (!_config?.appsec?.apiSecurity?.endpointCollectionEnabled) return

  config = _config
  application = _application
  host = _host
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDataFunction

  fastifyRouteCh.subscribe(onFastifyRoute)
  expressRouteCh.subscribe(onExpressRoute)
}

function stop () {
  fastifyRouteCh.unsubscribe(onFastifyRoute)
  expressRouteCh.unsubscribe(onExpressRoute)

  pendingEndpoints.clear()
  flushScheduled = false
  config = application = host = getRetryData = updateRetryData = null
}

module.exports = {
  start,
  stop
}
