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

/** @param {object} moduleExports */
function patchPromisifiedHandlerModule (moduleExports) {
  shimmer.wrap(moduleExports, 'promisifiedHandler', promisify => {
    return handler => datadog(promisify(handler))
  })
  return moduleExports
}

/** @param {string} handlerPath */
function patchLambdaModule (handlerPath) {
  return lambdaModule => {
    const descriptor = Object.getOwnPropertyDescriptor(lambdaModule, handlerPath)
    if (typeof descriptor?.value === 'function') {
      if (!descriptor.configurable && !descriptor.writable) return lambdaModule
      // The monitor copies Lambda metadata without invoking application accessors or Proxy traps.
      // Generic shimmer wrapping would copy the original properties back onto that safe wrapper.
      descriptor.value = datadog(descriptor.value)
      Object.defineProperty(lambdaModule, handlerPath, descriptor)
    } else {
      shimmer.wrap(lambdaModule, handlerPath, patchLambdaHandler)
    }
    return lambdaModule
  }
}

/** @param {Function} lambdaHandler */
function patchLambdaHandler (lambdaHandler) {
  return datadog(lambdaHandler)
}

const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
const originalLambdaHandler = getValueFromEnvSources('DD_LAMBDA_HANDLER')

// Observe the shim's selected completion Promise inside the invocation span's async scope.
// The npm package keeps dist/; Lambda layer builds place its contents directly in the package root.
addHook({ name: 'datadog-lambda-js', file: 'dist/utils/handler.js' }, patchPromisifiedHandlerModule)
addHook({ name: 'datadog-lambda-js', file: 'utils/handler.js' }, patchPromisifiedHandlerModule)

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
