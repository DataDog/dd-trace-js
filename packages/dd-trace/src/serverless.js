'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

const isVercelAtStartup = getEnvironmentVariable('VERCEL') === '1'

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
    return require('./serverless/vercel').getVercelPlatformTags()
  }
}

/**
 * Detects the serverless platform once while configuration is built.
 * @returns {{ isVercel: boolean }}
 */
function getServerlessPlatform () {
  return { isVercel: supportsServerlessTelemetryRetention() }
}

/**
 * Whether the current platform can retain an invocation for telemetry delivery.
 *
 * Add future serverless platforms here as they gain an equivalent retention hook.
 * @returns {boolean}
 */
function supportsServerlessTelemetryRetention () {
  return isVercelAtStartup
}

/**
 * Creates delivery tracking for platforms with an invocation retention hook.
 */
function createServerlessDeliveryTracker () {
  if (supportsServerlessTelemetryRetention()) {
    return new (require('./serverless/telemetry-delivery-tracker'))()
  }
}

/**
 * Registers the lifecycle adapter selected by the detected serverless platform.
 * @param {{ flushAll?: (done: () => void) => void }} tracer
 */
function initializeServerlessTelemetry (tracer) {
  if (supportsServerlessTelemetryRetention()) {
    return require('./serverless/vercel').registerVercelTelemetryRetention(tracer)
  }
}

module.exports = {
  getServerlessPlatformTags,
  getServerlessPlatform,
  supportsServerlessTelemetryRetention,
  createServerlessDeliveryTracker,
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  initializeServerlessTelemetry,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
