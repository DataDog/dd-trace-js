'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const VERCEL_REQUEST_CONTEXTS = [
  Symbol.for('@next/request-context'),
  Symbol.for('@vercel/request-context'),
]

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

function retainVercelRequest (promise) {
  if (getEnvironmentVariable('VERCEL') !== '1') return false

  for (const requestContext of VERCEL_REQUEST_CONTEXTS) {
    try {
      const waitUntil = globalThis[requestContext]?.get?.()?.waitUntil
      if (typeof waitUntil !== 'function') continue
      waitUntil(promise)
      return true
    } catch {
      // The other request-context implementation may still be available.
    }
  }

  return false
}

function flushVercelOtlp (tracer) {
  if (getEnvironmentVariable('VERCEL') !== '1') return false

  tracer = tracer?._tracer || tracer
  const flushes = []

  if (tracer?._config?.OTEL_TRACES_EXPORTER === 'otlp' && typeof tracer._exporter?.forceFlush === 'function') {
    flushes.push(() => tracer._exporter.forceFlush())
  }

  if (tracer?._config?.DD_LOGS_OTEL_ENABLED === true) {
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    if (typeof loggerProvider?.forceFlush === 'function') flushes.push(() => loggerProvider.forceFlush())
  }

  if (tracer?._config?.DD_METRICS_OTEL_ENABLED === true) {
    const { metrics } = require('@opentelemetry/api')
    const metricReader = metrics.getMeterProvider()?.reader
    if (typeof metricReader?.forceFlush === 'function') flushes.push(() => metricReader.forceFlush())
  }

  if (flushes.length === 0) return false

  const pending = flushes.map(flush => {
    try {
      return flush()
    } catch (error) {
      return Promise.reject(error)
    }
  })
  return retainVercelRequest(Promise.allSettled(pending))
}

module.exports = {
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  flushVercelOtlp,
  retainVercelRequest,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
