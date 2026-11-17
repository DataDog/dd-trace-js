'use strict'

const { channel } = require('dc-polyfill')

const { getEnvironmentVariable, getValueFromEnvSources } = require('../config/helper')

const loadChannel = channel('dd-trace:instrumentation:load')
let initialized = false

// Called during tracer configuration so importing the facade early does not freeze Lambda detection.
module.exports = function initialize () {
  if (initialized || getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') === undefined ||
    isDisabled(getValueFromEnvSources('DD_TRACE_DISABLED_INSTRUMENTATIONS'))) return

  registerHooks()
  initialized = true

  // Plugin disabling must leave the legacy shim's timeout hooks active. Handle the legacy alias
  // here without changing the plugin manager's disabled-plugin registry.
  if (!isDisabled(getValueFromEnvSources('DD_TRACE_DISABLED_PLUGINS'))) {
    loadChannel.publish({ name: 'aws-lambda' })
  }
}

/** @param {string | undefined} value Disabled integration names. */
function isDisabled (value) {
  return value?.split(',').some(name => ['lambda', 'aws-lambda'].includes(name.trim())) ?? false
}

function registerHooks () {
  // Keep handler-loading dependencies lazy outside Lambda and when instrumentation is disabled.
  const path = require('node:path')

  const Hook = require('../../../datadog-instrumentations/src/helpers/hook')
  const instrumentations = require('../../../datadog-instrumentations/src/helpers/instrumentations')
  const { filename, pathSepExpr } = require('../../../datadog-instrumentations/src/helpers/register')
  const log = require('../log')
  const {
    extractModuleNameAndHandlerPath,
    extractModuleRootAndHandler,
    getLambdaFilePaths,
  } = require('./handler-paths')
  const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
  const originalLambdaHandler = getValueFromEnvSources('DD_LAMBDA_HANDLER')

  if (originalLambdaHandler !== undefined && lambdaTaskRoot !== undefined) {
    const [moduleRoot, moduleAndHandler] = extractModuleRootAndHandler(originalLambdaHandler)
    const [moduleName] = extractModuleNameAndHandlerPath(moduleAndHandler)

    const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, moduleName)
    const lambdaFilePaths = getLambdaFilePaths(lambdaStylePath)

    // TODO: Redo this like any other instrumentation.
    Hook(lambdaFilePaths, (moduleExports, name, _, moduleVersion) => {
      require('./runtime/patch')

      for (const { hook } of instrumentations[name]) {
        try {
          moduleExports = hook(moduleExports, moduleVersion) ?? moduleExports
        } catch (error) {
          log.error('Error executing lambda hook', error)
        }
      }

      return moduleExports
    })
  }

  const moduleToPatch = 'datadog-lambda-js'
  Hook([moduleToPatch], (moduleExports, moduleName, _, moduleVersion) => {
    moduleName = moduleName.replace(pathSepExpr, '/')
    require('./runtime/patch')

    for (const { file, hook } of instrumentations[moduleToPatch]) {
      const fullFilename = filename(moduleToPatch, file)
      if (moduleName === fullFilename) {
        try {
          moduleExports = hook(moduleExports, moduleVersion) ?? moduleExports
        } catch (error) {
          log.error('Error executing lambda hook for datadog-lambda-js', error)
        }
      }
    }

    return moduleExports
  })

  // The published datadog-lambda-js ESM entrypoint imports this helper before initializing the tracer.
  // Revisit cached copies through the registered hook without loading datadog-lambda-js early.
  const helperSuffixes = [
    path.join('datadog-lambda-js', 'dist', 'utils', 'handler.js'),
    path.join('datadog-lambda-js', 'utils', 'handler.js'),
  ]
  for (const filename of Object.keys(require.cache)) {
    if (!helperSuffixes.some(suffix => filename.endsWith(path.sep + suffix))) continue
    try {
      require(filename)
    } catch (error) {
      log.error('Error executing cached lambda hook for datadog-lambda-js: %s', error)
    }
  }
}
