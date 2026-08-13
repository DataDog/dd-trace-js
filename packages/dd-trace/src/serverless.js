'use strict'

const { channel } = require('dc-polyfill')
const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const nextRequestFinishChannel = channel('apm:next:request:finish')
const httpRequestFinishChannel = channel('apm:http:server:request:finish')
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
const VERCEL_FLUSH_TIMEOUT = 2_000
const vercelRetentionHandlers = new WeakMap()
const retainedVercelRequests = new WeakSet()

function getIsGCPFunction () {
  const isDeprecatedGCPFunction =
    getEnvironmentVariable('FUNCTION_NAME') !== undefined &&
    getEnvironmentVariable('GCP_PROJECT') !== undefined
  const isNewerGCPFunction =
    getEnvironmentVariable('K_SERVICE') !== undefined &&
    getEnvironmentVariable('FUNCTION_TARGET') !== undefined

  return isDeprecatedGCPFunction || isNewerGCPFunction
}

/**
 * Enable GCP Pub/Sub PUSH subscription tracing for Cloud Run (K_SERVICE present).
 * PUSH: GCP sends HTTP POST requests to the service with message data in headers.
 *
 * Stays on the env helper to avoid closing the
 * `config -> serverless -> config` import cycle.
 */
function enableGCPPubSubPushSubscription () {
  return getEnvironmentVariable('K_SERVICE') !== undefined &&
    getValueFromEnvSources('DD_TRACE_GCP_PUBSUB_PUSH_ENABLED')
}

function getIsAzureFunction () {
  return getEnvironmentVariable('FUNCTIONS_EXTENSION_VERSION') !== undefined &&
    getEnvironmentVariable('FUNCTIONS_WORKER_RUNTIME') !== undefined
}

function getIsFlexConsumptionAzureFunction () {
  return getIsAzureFunction() && getEnvironmentVariable('WEBSITE_SKU') === 'FlexConsumption'
}

function isInServerlessEnvironment () {
  const inAWSLambda = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
  const isGCPFunction = getIsGCPFunction()
  const isAzureFunction = getIsAzureFunction()

  return inAWSLambda || isGCPFunction || isAzureFunction
}

/**
 * Gets tags describing the serverless platform where the tracer is running.
 *
 * @param {{ isVercel: boolean }} [platform] Detected serverless platform.
 * @returns {string[]|undefined}
 */
function getServerlessPlatformTags (platform = getServerlessPlatform()) {
  if (platform.isVercel) {
    return getVercelPlatformTags()
  }
}

/**
 * Detects the serverless platform once while configuration is built.
 * @returns {{ isVercel: boolean }}
 */
function getServerlessPlatform () {
  return { isVercel: getEnvironmentVariable('VERCEL') === '1' }
}

/**
 * @typedef {{ flushAll?: (done: () => void) => void }} TelemetryFlusher
 */

/**
 * @param {TelemetryFlusher} tracer
 * @param {() => void} done
 * @returns {void}
 */
function flushVercelTelemetry (tracer, done) {
  let completed = false
  const complete = () => {
    if (completed) return
    completed = true
    clearTimeout(timeout)
    done()
  }
  const timeout = setTimeout(complete, VERCEL_FLUSH_TIMEOUT)

  setImmediate(() => {
    try {
      tracer.flushAll(complete)
    } catch {
      complete()
    }
  })
}

function registerVercelRequestFlush (tracer) {
  const requestContext = getVercelRequestContext()
  if (!requestContext || retainedVercelRequests.has(requestContext)) return

  const { waitUntil } = requestContext
  if (typeof waitUntil !== 'function') return
  retainedVercelRequests.add(requestContext)

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
 * Registers the lifecycle adapter selected by the detected serverless platform.
 * @param {TelemetryFlusher} tracer
 */
function initializeServerlessTelemetry (tracer) {
  if (getServerlessPlatform().isVercel) return registerVercelTelemetryRetention(tracer)
}

/**
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
  getServerlessPlatformTags,
  getServerlessPlatform,
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  registerVercelTelemetryRetention,
  initializeServerlessTelemetry,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
