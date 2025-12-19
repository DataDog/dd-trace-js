'use strict'

const { getEnvironmentVariable } = require('./config-helper')
const { isFalse } = require('./util')

function getIsGCPFunction () {
  const isDeprecatedGCPFunction =
    process.env.FUNCTION_NAME !== undefined &&
    process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction =
    process.env.K_SERVICE !== undefined &&
    process.env.FUNCTION_TARGET !== undefined

  return isDeprecatedGCPFunction || isNewerGCPFunction
}

/**
 * Enable GCP Pub/Sub PUSH subscription tracing for Cloud Run (K_SERVICE present).
 * PUSH: GCP sends HTTP POST requests to the service with message data in headers.
 */
function enableGCPPubSubPushSubscription () {
  const isGCPPubSubPushSubscriptionEnabled = getEnvironmentVariable('DD_TRACE_GCP_PUBSUB_PUSH_ENABLED')
  return getEnvironmentVariable('K_SERVICE') !== undefined && !isFalse(isGCPPubSubPushSubscriptionEnabled)
}

function getIsAzureFunction () {
  const isAzureFunction =
    process.env.FUNCTIONS_EXTENSION_VERSION !== undefined &&
    process.env.FUNCTIONS_WORKER_RUNTIME !== undefined

  return isAzureFunction
}

function getIsFlexConsumptionAzureFunction () {
  return getIsAzureFunction() && getEnvironmentVariable('WEBSITE_SKU') === 'FlexConsumption'
}

function isInServerlessEnvironment () {
  const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
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
