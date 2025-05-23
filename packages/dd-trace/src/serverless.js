'use strict'

function getIsGCPFunction () {
  const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined

  return isDeprecatedGCPFunction || isNewerGCPFunction
}

function getIsAzureFunction () {
  const isAzureFunction =
    process.env.FUNCTIONS_EXTENSION_VERSION !== undefined && process.env.FUNCTIONS_WORKER_RUNTIME !== undefined

  return isAzureFunction
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
  isInServerlessEnvironment
}
