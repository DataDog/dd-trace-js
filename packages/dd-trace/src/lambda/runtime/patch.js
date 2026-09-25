'use strict'

const path = require('path')

const { datadog } = require('../handler')
const { addHook } = require('../../../../datadog-instrumentations/src/helpers/instrument')
const shimmer = require('../../../../datadog-shimmer')
const { isTrue } = require('../../util')
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

/**
 * Transitional migration gate, default off.
 *
 * Pre-migration datadog-lambda-js wraps the customer handler with its own full instrumentation.
 * If dd-trace also wraps (its `datadog()` now produces an `aws.lambda` span via the aws-lambda
 * plugin), customers running the old shim alongside a new dd-trace get two invocation spans per
 * invoke — the released shim does not know the `Symbol.for('dd-trace.lambda.wrapped')` marker,
 * and dd-trace deliberately does not claim the shim's `_ddWrapped` marker. So the dual wrap only
 * happens when explicitly enabled (migration testing); the gate goes away once the shim delegates
 * to `dd-trace/lambda` and the marker makes double wrapping idempotent.
 *
 * Migration-internal knob: registered in supported-configurations.json (env access validation
 * requires it) but intentionally not mapped to a customer-facing config option.
 *
 * @param {Function} datadogHandler
 */
function patchDatadogLambdaHandler (datadogHandler) {
  if (!isTrue(getValueFromEnvSources('DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS'))) {
    return userHandler => datadogHandler(userHandler)
  }
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
