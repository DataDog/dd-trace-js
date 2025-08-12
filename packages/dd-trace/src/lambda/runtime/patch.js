'use strict'

const path = require('path')

const { _extractModuleNameAndHandlerPath, _extractModuleRootAndHandler, _getLambdaFilePaths } = require('./ritm')
const { datadog } = require('../handler')
const { addHook } = require('../../../../datadog-instrumentations/src/helpers/instrument')
const shimmer = require('../../../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../config-helper')

/**
 * Patches a Datadog Lambda module by calling `patchDatadogLambdaHandler`
 * with the handler name `datadog`.
 *
 * @param {*} datadogLambdaModule node module to be patched.
 * @returns a Datadog Lambda module with the `datadog` function from
 * `datadog-lambda-js` patched.
 */
const patchDatadogLambdaModule = (datadogLambdaModule) => {
  shimmer.wrap(datadogLambdaModule, 'datadog', patchDatadogLambdaHandler)

  return datadogLambdaModule
}

/**
 * Patches a Datadog Lambda handler in order to do
 * Datadog instrumentation by getting the Lambda handler from its
 * arguments.
 *
 * @param {*} datadogHandler the Datadog Lambda handler to destructure.
 * @returns the datadogHandler with its arguments patched.
 */
function patchDatadogLambdaHandler (datadogHandler) {
  return (userHandler) => {
    return datadogHandler(datadog(userHandler))
  }
}

/**
 * Patches a Lambda module on the given handler path.
 *
 * @param {string} handlerPath path of the handler to be patched.
 * @returns a module with the given handler path patched.
 */
const patchLambdaModule = (handlerPath) => (lambdaModule) => {
  shimmer.wrap(lambdaModule, handlerPath, patchLambdaHandler)

  return lambdaModule
}

/**
 * Patches a Lambda handler in order to do Datadog instrumentation.
 *
 * @param {*} lambdaHandler the Lambda handler to be patched.
 * @returns a function which patches the given Lambda handler.
 */
function patchLambdaHandler (lambdaHandler) {
  return datadog(lambdaHandler)
}

const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
const originalLambdaHandler = getEnvironmentVariable('DD_LAMBDA_HANDLER')

if (originalLambdaHandler === undefined) {
  // Instrumentation is done manually.
  addHook({ name: 'datadog-lambda-js' }, patchDatadogLambdaModule)
} else {
  const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler)
  const [_module, handlerPath] = _extractModuleNameAndHandlerPath(moduleAndHandler)

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module)
  const lambdaFilePaths = _getLambdaFilePaths(lambdaStylePath)

  for (const lambdaFilePath of lambdaFilePaths) {
    addHook({ name: lambdaFilePath }, patchLambdaModule(handlerPath))
  }
}
