'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')

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
 * Gets tags describing the platform where the tracer is running.
 *
 * @returns {Record<string, string>}
 */
function getPlatformTags () {
  return getVercelTags()
}

/**
 * @returns {Record<string, string>}
 */
function getVercelTags () {
  if (getEnvironmentVariable('VERCEL') !== '1') return {}

  const tags = {
    'vercel.project_id': getEnvironmentVariable('VERCEL_PROJECT_ID'),
    'vercel.environment': getEnvironmentVariable('VERCEL_ENV'),
    'vercel.region': getEnvironmentVariable('VERCEL_REGION'),
  }

  for (const [name, value] of Object.entries(tags)) {
    if (!value) delete tags[name]
  }

  return tags
}

module.exports = {
  getPlatformTags,
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
