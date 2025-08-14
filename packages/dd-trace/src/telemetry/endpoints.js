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

function start (_config = {}, _application, _host, getRetryDataFunction, updateRetryDatafunction) {
  if (!_config?.appsec?.apiSecurity?.endpointCollectionEnabled) return

  config = _config
  application = _application
  host = _host
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDatafunction

  fastifyRouteCh.subscribe(onFastifyRoute)
}

function stop () {
  fastifyRouteCh.unsubscribe(onFastifyRoute)

  pendingEndpoints.clear()
  flushScheduled = false
  config = application = host = getRetryData = updateRetryData = null
}

module.exports = {
  start,
  stop
}
