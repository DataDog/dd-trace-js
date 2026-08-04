'use strict'

const path = require('path')

const { datadog } = require('../handler')
const { addHook } = require('../../../../datadog-instrumentations/src/helpers/instrument')
const shimmer = require('../../../../datadog-shimmer')
const { getEnvironmentVariable, getValueFromEnvSources } = require('../../config/helper')
const {
  extractModuleNameAndHandlerPath,
  extractModuleRootAndHandler,
  getLambdaFilePaths,
} = require('../handler-paths')

/** @param {object} datadogLambdaModule */
function patchDatadogLambdaModule (datadogLambdaModule) {
  shimmer.wrap(datadogLambdaModule, 'datadog', patchDatadogLambdaHandler)
  return datadogLambdaModule
}

/** @param {Function} datadogHandler */
function patchDatadogLambdaHandler (datadogHandler) {
  return userHandler => datadogHandler(datadog(userHandler))
}

/** @param {string} handlerPath */
function patchLambdaModule (handlerPath) {
  return lambdaModule => {
    shimmer.wrap(lambdaModule, handlerPath, patchLambdaHandler)
    return lambdaModule
  }
}

/** @param {Function} lambdaHandler */
function patchLambdaHandler (lambdaHandler) {
  return datadog(lambdaHandler)
}

const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
const originalLambdaHandler = getValueFromEnvSources('DD_LAMBDA_HANDLER')

if (originalLambdaHandler === undefined) {
  addHook({ name: 'datadog-lambda-js' }, patchDatadogLambdaModule)
} else {
  const [moduleRoot, moduleAndHandler] = extractModuleRootAndHandler(originalLambdaHandler)
  const [moduleName, handlerPath] = extractModuleNameAndHandlerPath(moduleAndHandler)

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, moduleName)
  for (const lambdaFilePath of getLambdaFilePaths(lambdaStylePath)) {
    addHook({ name: lambdaFilePath }, patchLambdaModule(handlerPath))
  }
}
