'use strict'

function getIsGCPFunction () {
  const isDeprecatedGCPFunction =
    getConfiguration('FUNCTION_NAME') !== undefined &&
    getConfiguration('GCP_PROJECT') !== undefined
  const isNewerGCPFunction =
    getConfiguration('K_SERVICE') !== undefined &&
    getConfiguration('FUNCTION_TARGET') !== undefined

  return isDeprecatedGCPFunction || isNewerGCPFunction
}

function getIsAzureFunction () {
  const isAzureFunction =
    getConfiguration('FUNCTIONS_EXTENSION_VERSION') !== undefined &&
    getConfiguration('FUNCTIONS_WORKER_RUNTIME') !== undefined

  return isAzureFunction
}

function isInServerlessEnvironment () {
  const inAWSLambda = getConfiguration('AWS_LAMBDA_FUNCTION_NAME') !== undefined
  const isGCPFunction = getIsGCPFunction()
  const isAzureFunction = getIsAzureFunction()

  return inAWSLambda || isGCPFunction || isAzureFunction
}

module.exports = {
  getIsGCPFunction,
  getIsAzureFunction,
  isInServerlessEnvironment
}
