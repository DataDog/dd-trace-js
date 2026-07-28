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

function getVercelAgentlessExporter (tracer) {
  if (getEnvironmentVariable('VERCEL') !== '1') return false

  tracer = tracer?._tracer || tracer
  if (tracer?._config?.experimental?.exporter !== 'agentless') return false
  if (typeof tracer._exporter?.flush !== 'function') return false
  return tracer._exporter
}

function getVercelWaitUntil () {
  let waitUntil
  for (const requestContext of VERCEL_REQUEST_CONTEXTS) {
    try {
      waitUntil = globalThis[requestContext]?.get?.()?.waitUntil
    } catch {
      continue
    }
    if (typeof waitUntil === 'function') break
  }
  return waitUntil
}

/**
 * Reserve a task in Vercel's active request lifetime, returning a function that
 * flushes agentless traces and completes the task.
 *
 * @param {import('./opentracing/tracer') | {_tracer: import('./opentracing/tracer')}} tracer Datadog tracer instance.
 * @returns {Function | undefined} Function that starts the registered export.
 */
function registerVercelFlush (tracer) {
  const exporter = getVercelAgentlessExporter(tracer)
  if (!exporter) return

  const waitUntil = getVercelWaitUntil()
  if (typeof waitUntil !== 'function') return

  let resolveFlush
  const promise = new Promise(resolve => {
    resolveFlush = resolve
  })

  try {
    waitUntil(promise)
  } catch {
    resolveFlush()
    return
  }

  let started = false
  return () => {
    if (started) return
    started = true
    setImmediate(flushExporter, exporter, resolveFlush)
  }
}

/**
 * Register and immediately schedule an agentless export with Vercel's active
 * request lifetime.
 *
 * @param {import('./opentracing/tracer') | {_tracer: import('./opentracing/tracer')}} tracer Datadog tracer instance.
 * @returns {boolean} Whether the export was registered with the request context.
 */
function scheduleVercelFlush (tracer) {
  const flush = registerVercelFlush(tracer)
  if (!flush) return false
  flush()
  return true
}

function flushExporter (exporter, done) {
  try {
    exporter.flush(done)
  } catch {
    done()
  }
}

module.exports = {
  getIsGCPFunction,
  getIsAzureFunction,
  registerVercelFlush,
  scheduleVercelFlush,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
