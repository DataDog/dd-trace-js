'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable } = require('../config/helper')

const httpRequestStartChannel = channel('apm:http:server:request:start')
const httpRequestFinishChannel = channel('apm:http:server:request:finish')
const http2ResponseEmitChannel = channel('apm:http2:server:response:emit')
const nextRequestStartChannel = channel('apm:next:request:start')
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
const VERCEL_FLUSH_TIMEOUT = 2_000
const vercelRetentionHandlers = new WeakMap()
const retainedVercelRequests = new WeakMap()

/**
 * @typedef {{ flushAll?: (done: () => void, options?: { timeout?: number }) => void }} TelemetryFlusher
 */

/**
 * @param {TelemetryFlusher} tracer
 * @param {() => void} done
 * @returns {void}
 */
function flushVercelTelemetry (tracer, done) {
  setImmediate(() => {
    try {
      tracer.flushAll(done, { timeout: VERCEL_FLUSH_TIMEOUT })
    } catch {
      done()
    }
  })
}

function getRequestKey (req) {
  return req?.originalRequest || req
}

function retainVercelRequest (req, tracer) {
  req = getRequestKey(req)
  if (!req || typeof req !== 'object') return false

  let retainedTracers = retainedVercelRequests.get(req)
  if (!retainedTracers) {
    retainedTracers = new WeakMap()
    retainedVercelRequests.set(req, retainedTracers)
  }
  if (retainedTracers.has(tracer)) return true

  const requestContext = getVercelRequestContext()
  if (!requestContext) return false

  const { waitUntil } = requestContext
  if (typeof waitUntil !== 'function') return false

  let done
  const pending = new Promise(resolve => { done = resolve })
  try {
    waitUntil(pending)
    retainedTracers.set(tracer, { done, tracer })
    return true
  } catch {
    done()
    return false
  }
}

function flushVercelRequest (req, tracer) {
  req = getRequestKey(req)
  if (!req || typeof req !== 'object') return
  const retainedTracers = retainedVercelRequests.get(req)
  const retained = retainedTracers?.get(tracer)
  if (!retained || retained.flushed) return

  retained.flushed = true
  flushVercelTelemetry(retained.tracer, retained.done)
}

function registerVercelRequestFlush (tracer) {
  const requestContext = getVercelRequestContext()
  if (!requestContext) return

  const { waitUntil } = requestContext
  if (typeof waitUntil !== 'function') return
  let done
  const pending = new Promise(resolve => { done = resolve })
  try {
    waitUntil(pending)
    flushVercelTelemetry(tracer, done)
  } catch {
    done()
  }
}

function getVercelRequestContext () {
  return globalThis[VERCEL_REQUEST_CONTEXT]?.get?.()
}

/**
 * Retains a Vercel Node Function until configured telemetry exporters complete.
 *
 * @param {TelemetryFlusher} tracer
 * @returns {(() => void)|undefined}
 */
function registerVercelTelemetryRetention (tracer) {
  const existing = vercelRetentionHandlers.get(tracer)
  if (existing) return existing

  if (typeof tracer?.flushAll !== 'function') return
  const retainRequest = ({ req }) => retainVercelRequest(req, tracer)
  const startNextRequest = ({ req }) => retainVercelRequest(req, tracer)
  const finishHttpRequest = ({ req }) => {
    req = getRequestKey(req)
    const retained = retainVercelRequest(req, tracer)
    if (retained) flushVercelRequest(req, tracer)
    else registerVercelRequestFlush(tracer)
  }
  const flushHttp2Response = ({ eventName }) => {
    if (eventName === 'close') registerVercelRequestFlush(tracer)
  }
  httpRequestStartChannel.subscribe(retainRequest)
  httpRequestFinishChannel.subscribe(finishHttpRequest)
  http2ResponseEmitChannel.subscribe(flushHttp2Response)
  nextRequestStartChannel.subscribe(startNextRequest)

  const unregister = () => {
    httpRequestStartChannel.unsubscribe(retainRequest)
    httpRequestFinishChannel.unsubscribe(finishHttpRequest)
    http2ResponseEmitChannel.unsubscribe(flushHttp2Response)
    nextRequestStartChannel.unsubscribe(startNextRequest)
    vercelRetentionHandlers.delete(tracer)
  }
  vercelRetentionHandlers.set(tracer, unregister)
  return unregister
}

/**
 * Gets Vercel deployment tags to attach to spans.
 *
 * @returns {string[]|undefined}
 */
function getVercelPlatformTags () {
  let tags
  const projectId = getEnvironmentVariable('VERCEL_PROJECT_ID')
  if (projectId) {
    tags = ['vercel.project_id', projectId]
  }

  const environment = getEnvironmentVariable('VERCEL_ENV')
  if (environment) {
    tags ??= []
    tags.push('vercel.environment', environment)
  }

  const region = getEnvironmentVariable('VERCEL_REGION')
  if (region) {
    tags ??= []
    tags.push('vercel.region', region)
  }

  return tags
}

module.exports = {
  getVercelPlatformTags,
  registerVercelTelemetryRetention,
}
