'use strict'

const dc = require('dc-polyfill')
const { sendData } = require('./send-data')

const fastifyRouteCh = dc.channel('apm:fastify:route:added')

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
let flushScheduled = false

function endpointKey (method, path) {
  return `${method} ${path}`
}

function scheduleFlush () {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(flushAndSend).unref()
}

function recordEndpoint (method, path) {
  if (!method || !path) return

  const key = endpointKey(method, path)
  if (pendingEndpoints.has(key)) return

  pendingEndpoints.set(key, { method: method.toUpperCase(), path })
  scheduleFlush()
}

function onFastifyRoute (routeData) {
  if (!routeData) return

  const { routeOptions } = routeData
  if (!routeOptions) return
  if (!routeOptions.path) return

  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]

  // Check if this is a wildcard route fastify.all()
  if (methods.length === 8) {
    recordEndpoint('*', routeOptions.path)
  } else {
    for (const method of methods) {
      recordEndpoint(method, routeOptions.path)
    }
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
    is_first: true,
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

  // If more endpoints accumulated while sending, schedule another flush.
  if (pendingEndpoints.size) scheduleFlush()
}

function start (_config = {}, _application, _host, getRetryDataFunction, updateRetryDatafunction) {
  config = _config
  application = _application
  host = _host
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDatafunction

  if (config.appsec?.apiSecurity?.endpointCollectionEnabled) {
    fastifyRouteCh.subscribe(onFastifyRoute)
  }
}

function stop () {
  if (fastifyRouteCh.hasSubscribers) {
    fastifyRouteCh.unsubscribe(onFastifyRoute)
  }

  pendingEndpoints.clear()
  flushScheduled = false
  config = application = host = getRetryData = updateRetryData = null
}

module.exports = {
  start,
  stop
}
