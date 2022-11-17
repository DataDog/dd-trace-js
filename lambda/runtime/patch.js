'use strict'

const path = require('path')

const { _extractModuleNameAndHandlerPath, _extractModuleRootAndHandler, _getLambdaFilePath } = require('./ritm')
const { datadog } = require('../handler')
const { addHook } = require('../../packages/datadog-instrumentations/src/helpers/instrument')
const shimmer = require('../../packages/datadog-shimmer')

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

/**
 * Immediately Invoked Function Expression (IIFE) to avoid
 * error on previously defined constants.
 */
(() => {
  const lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
  const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER

  const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler)
  const [_module, handlerPath] = _extractModuleNameAndHandlerPath(moduleAndHandler)

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module)
  const lambdaFilePath = _getLambdaFilePath(lambdaStylePath)

  addHook({ name: lambdaFilePath }, patchLambdaModule(handlerPath))
})()
