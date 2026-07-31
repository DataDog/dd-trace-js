'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const VERCEL_REQUEST_CONTEXTS = [
  Symbol.for('@next/request-context'),
  Symbol.for('@vercel/request-context'),
]

function getIsAWSLambda () {
  return getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
}

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
  const isGCPFunction = getIsGCPFunction()
  const isAzureFunction = getIsAzureFunction()

  return getIsAWSLambda() || isGCPFunction || isAzureFunction
}

function getVercelNativeOtlpExporter (tracer) {
  if (getEnvironmentVariable('VERCEL') !== '1') return

  tracer = tracer?._tracer || tracer
  if (tracer?._config?.OTEL_TRACES_EXPORTER !== 'otlp') return
  if (typeof tracer._exporter?.flush !== 'function') return
  return tracer._exporter
}

function getVercelOtelLoggerProvider (tracer) {
  if (getEnvironmentVariable('VERCEL') !== '1') return

  tracer = tracer?._tracer || tracer
  if (tracer?._config?.DD_LOGS_OTEL_ENABLED !== true) return

  const { logs } = require('@opentelemetry/api-logs')
  const loggerProvider = logs.getLoggerProvider()
  if (typeof loggerProvider?.forceFlush !== 'function') return
  return loggerProvider
}

function getVercelWaitUntil () {
  for (const requestContext of VERCEL_REQUEST_CONTEXTS) {
    try {
      const waitUntil = globalThis[requestContext]?.get?.()?.waitUntil
      if (typeof waitUntil === 'function') return waitUntil
    } catch {
      // The other context symbol may still be available in this runtime.
    }
  }
}

function scheduleVercelFlush (tracer) {
  const exporter = getVercelNativeOtlpExporter(tracer)
  const loggerProvider = getVercelOtelLoggerProvider(tracer)
  if (!exporter && !loggerProvider) return false

  const waitUntil = getVercelWaitUntil()
  if (!waitUntil) return false

  let resolveFlush
  const flushPromise = new Promise(resolve => {
    resolveFlush = resolve
  })

  try {
    waitUntil(flushPromise)
  } catch {
    resolveFlush()
    return false
  }

  setImmediate(flushExporters, exporter, loggerProvider, resolveFlush)
  return true
}

async function flushExporters (exporter, loggerProvider, done) {
  const flushes = []
  if (exporter) {
    flushes.push(new Promise(resolve => exporter.flush(resolve)))
  }
  if (loggerProvider) {
    flushes.push(Promise.resolve().then(() => loggerProvider.forceFlush()))
  }
  await Promise.allSettled(flushes)
  done()
}

module.exports = {
  getIsAWSLambda,
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  scheduleVercelFlush,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
