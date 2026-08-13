'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable } = require('../config/helper')

const nextRequestFinishChannel = channel('apm:next:request:finish')
const httpRequestFinishChannel = channel('apm:http:server:request:finish')
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

function registerVercelRequestFlush (tracer) {
  const requestContext = getVercelRequestContext()
  if (!requestContext) return

  const { waitUntil } = requestContext
  if (typeof waitUntil !== 'function') return
  let retainedTracers = retainedVercelRequests.get(requestContext)
  if (!retainedTracers) {
    retainedTracers = new WeakSet()
    retainedVercelRequests.set(requestContext, retainedTracers)
  }
  if (retainedTracers.has(tracer)) return
  retainedTracers.add(tracer)

  // Retain the invocation synchronously, then flush after Next finishes its root span.
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
  const flushRequest = () => registerVercelRequestFlush(tracer)
  nextRequestFinishChannel.subscribe(flushRequest)
  httpRequestFinishChannel.subscribe(flushRequest)

  const unregister = () => {
    nextRequestFinishChannel.unsubscribe(flushRequest)
    httpRequestFinishChannel.unsubscribe(flushRequest)
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
