'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable } = require('../config/helper')
const log = require('../log')

const httpRequestStartChannel = channel('apm:http:server:request:start')
const httpRequestFinishChannel = channel('apm:http:server:request:finish')
const http2RequestStartChannel = channel('apm:http2:server:request:start')
const http2ResponseEmitChannel = channel('apm:http2:server:response:emit')
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
const VERCEL_FLUSH_TIMEOUT = 2000
const vercelRetentionHandlers = new WeakMap()

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
    } catch (error) {
      log.warn('Unable to flush Vercel telemetry:', error)
      done()
    }
  })
}

function registerVercelRequestFlush (tracer) {
  const requestContext = getVercelRequestContext()
  if (!requestContext) return

  const { waitUntil } = requestContext
  if (typeof waitUntil !== 'function') return

  // Retain the invocation synchronously, then flush after the response completes.
  let done
  const pending = new Promise(resolve => { done = resolve })
  try {
    waitUntil(pending)
    flushVercelTelemetry(tracer, done)
  } catch (error) {
    log.warn('Unable to retain Vercel telemetry:', error)
    done()
  }
}

function getVercelRequestContext () {
  return globalThis[VERCEL_REQUEST_CONTEXT]?.get?.()
}

// Keeps core response wrappers active without creating an HTTP tracing span.
function activateHttpLifecycle () {}

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
  // Keep the core response wrappers active even when the HTTP tracing plugins are disabled.
  const flushRequest = () => registerVercelRequestFlush(tracer)
  const flushHttp2Response = ({ eventName }) => {
    if (eventName === 'close') flushRequest()
  }
  httpRequestStartChannel.subscribe(activateHttpLifecycle)
  httpRequestFinishChannel.subscribe(flushRequest)
  http2RequestStartChannel.subscribe(activateHttpLifecycle)
  http2ResponseEmitChannel.subscribe(flushHttp2Response)

  const unregister = () => {
    httpRequestStartChannel.unsubscribe(activateHttpLifecycle)
    httpRequestFinishChannel.unsubscribe(flushRequest)
    http2RequestStartChannel.unsubscribe(activateHttpLifecycle)
    http2ResponseEmitChannel.unsubscribe(flushHttp2Response)
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
