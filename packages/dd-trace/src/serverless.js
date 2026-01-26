'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')
const { isFalse } = require('./util')

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
 */
function enableGCPPubSubPushSubscription () {
  const isGCPPubSubPushSubscriptionEnabled = getValueFromEnvSources('DD_TRACE_GCP_PUBSUB_PUSH_ENABLED')
  return getEnvironmentVariable('K_SERVICE') !== undefined && !isFalse(isGCPPubSubPushSubscriptionEnabled)
}

function getIsAzureFunction () {
  const isAzureFunction =
    getEnvironmentVariable('FUNCTIONS_EXTENSION_VERSION') !== undefined &&
    getEnvironmentVariable('FUNCTIONS_WORKER_RUNTIME') !== undefined

  return isAzureFunction
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

module.exports = {
  getIsGCPFunction,
  getIsAzureFunction,
  enableGCPPubSubPushSubscription,
  getIsFlexConsumptionAzureFunction,
  isInServerlessEnvironment
}
