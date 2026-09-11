'use strict'

const fs = require('node:fs')
const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')
const { DATADOG_LAMBDA_EXTENSION_PATH, DATADOG_MINI_AGENT_PATH } = require('./constants')

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

/**
 * Whether the Datadog Lambda Extension (or mini agent) is running alongside the function,
 * i.e. traces/events can be handed off to a local sidecar instead of an external intake.
 */
function isLambdaExtensionPresent () {
  return getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined && (
    fs.existsSync(DATADOG_LAMBDA_EXTENSION_PATH) ||
    fs.existsSync(DATADOG_MINI_AGENT_PATH)
  )
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
 * @returns {string[]|undefined}
 */
function getServerlessPlatformTags () {
  if (getEnvironmentVariable('VERCEL') === '1') {
    return getVercelPlatformTags()
  }
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
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  isLambdaExtensionPresent,
  IS_SERVERLESS: isInServerlessEnvironment(),
}
