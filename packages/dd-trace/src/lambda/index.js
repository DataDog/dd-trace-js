'use strict'

const path = require('path')

const log = require('../log')
const { getEnvironmentVariable, getValueFromEnvSources } = require('../config/helper')
const Hook = require('../../../datadog-instrumentations/src/helpers/hook')
const instrumentations = require('../../../datadog-instrumentations/src/helpers/instrumentations')
const {
  filename,
  pathSepExpr,
} = require('../../../datadog-instrumentations/src/helpers/register')
const {
  extractModuleNameAndHandlerPath,
  extractModuleRootAndHandler,
  getLambdaFilePaths,
} = require('./handler-paths')

if (!getValueFromEnvSources('DD_TRACE_DISABLED_INSTRUMENTATIONS')?.split(',').includes('lambda')) {
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

  // The published ESM shim imports this helper before initializing the tracer.
  // Revisit cached copies through the registered hook without loading a shim early.
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
