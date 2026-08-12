'use strict'

const { channel } = require('dc-polyfill')
const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const VERCEL_REQUEST_CONTEXTS = [
  Symbol.for('@next/request-context'),
  Symbol.for('@vercel/request-context'),
]
const httpRequestFinishChannel = channel('apm:http:server:request:finish')
const http2ResponseEmitChannel = channel('apm:http2:server:response:emit')
const vercelRetentionHandlers = new WeakMap()

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
 * @returns {(() => boolean)|undefined}
 */
function getVercelRequestEndHandler (tracer) {
  if (typeof tracer?.flushAll !== 'function') return

  return function onVercelRequestEnd () {
    for (const requestContext of VERCEL_REQUEST_CONTEXTS) {
      try {
        const waitUntil = globalThis[requestContext]?.get?.()?.waitUntil
        if (typeof waitUntil !== 'function') continue

        let done
        const pending = new Promise(resolve => { done = resolve })
        waitUntil(pending)
        try {
          tracer.flushAll(done)
        } catch {
          done()
        }
        return true
      } catch {
        // The other request-context implementation may still be available.
      }
    }
    return false
  }
}

/**
 * @param {TelemetryFlusher} tracer
 * @returns {(() => void)|undefined}
 */
function registerVercelTelemetryRetention (tracer) {
  const existing = vercelRetentionHandlers.get(tracer)
  if (existing) return existing

  const onRequestEnd = getVercelRequestEndHandler(tracer)
  if (!onRequestEnd) return

  const onHttp2ResponseEmit = ({ eventName }) => {
    if (eventName === 'close') onRequestEnd()
  }
  httpRequestFinishChannel.subscribe(onRequestEnd)
  http2ResponseEmitChannel.subscribe(onHttp2ResponseEmit)

  const unregister = () => {
    httpRequestFinishChannel.unsubscribe(onRequestEnd)
    http2ResponseEmitChannel.unsubscribe(onHttp2ResponseEmit)
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
  if (getServerlessPlatform().isVercel) registerVercelTelemetryRetention(tracer)
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
  getVercelRequestEndHandler,
  registerVercelTelemetryRetention,
  initializeServerlessTelemetry,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
