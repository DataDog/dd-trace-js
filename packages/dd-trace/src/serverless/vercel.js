'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable } = require('../config/helper')
const log = require('../log')

const httpRequestFinishChannel = channel('apm:http:server:request:finish')
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
      log.error('Failed to flush Vercel telemetry: %s', error)
      done()
    }
  })
}

function registerVercelRequestFlush (tracer) {
  let waitUntil
  try {
    const requestContext = getVercelRequestContext()
    if (!requestContext) return
    waitUntil = requestContext.waitUntil
  } catch (error) {
    log.error('Failed to access Vercel request context: %s', error)
    return
  }
  if (typeof waitUntil !== 'function') return

  // Retain the invocation synchronously, then flush after the response completes.
  let done
  const pending = new Promise(resolve => { done = resolve })
  try {
    waitUntil(pending)
    flushVercelTelemetry(tracer, done)
  } catch (error) {
    log.error('Failed to retain Vercel invocation: %s', error)
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
  const flushRequest = () => registerVercelRequestFlush(tracer)
  const flushHttp2Response = ({ eventName }) => {
    if (eventName === 'close') flushRequest()
  }
  httpRequestFinishChannel.subscribe(flushRequest)
  http2ResponseEmitChannel.subscribe(flushHttp2Response)

  const unregister = () => {
    httpRequestFinishChannel.unsubscribe(flushRequest)
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
