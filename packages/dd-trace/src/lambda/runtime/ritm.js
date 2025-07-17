/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Modifications copyright 2022 Datadog, Inc.
 *
 * Some functions are part of aws-lambda-nodejs-runtime-interface-client
 * https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/main/src/utils/UserFunction.ts
 */
'use strict'

const path = require('path')

const log = require('../../log')
const { getEnvironmentVariable } = require('../../config-helper')
const Hook = require('../../../../datadog-instrumentations/src/helpers/hook')
const instrumentations = require('../../../../datadog-instrumentations/src/helpers/instrumentations')
const {
  filename,
  pathSepExpr
} = require('../../../../datadog-instrumentations/src/helpers/register')

/**
 * Breaks the full handler string into two pieces: the module root
 * and the actual handler string.
 *
 * @param {string} fullHandler user's lambda handler, commonly stored in `DD_LAMBDA_HANDLER`.
 * @returns {string[]} an array containing the module root and the handler string.
 *
 * ```js
 * _extractModuleRootAndHandler('./api/src/index.nested.handler')
 * // => ['./api/src', 'index.nested.handler']
 * ```
 */
function _extractModuleRootAndHandler (fullHandler) {
  const handlerString = path.basename(fullHandler)
  const moduleRoot = fullHandler.slice(0, Math.max(0, fullHandler.indexOf(handlerString)))

  return [moduleRoot, handlerString]
}

/**
 * Splits the handler string into two pieces: the module name
 * and the path to the handler function.
 *
 * @param {string} handler a handler string containing the module and the handler path.
 * @returns {string[]} an array containing the module name and the handler path.
 *
 * ```js
 * _extractModuleNameAndHandlerPath('index.nested.handler')
 * // => ['index', 'nested.handler']
 * ```
 */
function _extractModuleNameAndHandlerPath (handler) {
  const FUNCTION_EXPR = /^([^.]*)\.(.*)$/
  const match = handler.match(FUNCTION_EXPR)
  if (!match || match.length !== 3) {
    // Malformed Handler Name
    return // TODO: throw error
  }
  return [match[1], match[2]] // [module, handler-path]
}

/**
 * Returns all possible paths of the files to be patched when required.
 *
 * @param {*} lambdaStylePath the path comprised of the `LAMBDA_TASK_ROOT`,
 * the root of the module of the Lambda handler, and the module name.
 * @returns the lambdaStylePath with appropiate extensions for the hook.
 */
function _getLambdaFilePaths (lambdaStylePath) {
  return [
    `${lambdaStylePath}.js`,
    `${lambdaStylePath}.mjs`,
    `${lambdaStylePath}.cjs`
  ]
}

/**
 * Register a hook for the Lambda handler to be executed when
 * the file is required.
 */
const registerLambdaHook = () => {
  const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
  const originalLambdaHandler = getEnvironmentVariable('DD_LAMBDA_HANDLER')

  if (originalLambdaHandler !== undefined && lambdaTaskRoot !== undefined) {
    const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler)
    const [_module] = _extractModuleNameAndHandlerPath(moduleAndHandler)

    const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module)
    const lambdaFilePaths = _getLambdaFilePaths(lambdaStylePath)

    // TODO: Redo this like any other instrumentation.
    Hook(lambdaFilePaths, (moduleExports, name) => {
      require('./patch')

      for (const { hook } of instrumentations[name]) {
        try {
          moduleExports = hook(moduleExports)
        } catch (e) {
          log.error('Error executing lambda hook', e)
        }
      }

      return moduleExports
    })
  } else {
    const moduleToPatch = 'datadog-lambda-js'
    Hook([moduleToPatch], (moduleExports, moduleName, _) => {
      moduleName = moduleName.replace(pathSepExpr, '/')

      require('./patch')

      for (const { name, file, hook } of instrumentations[moduleToPatch]) {
        const fullFilename = filename(name, file)
        if (moduleName === fullFilename) {
          try {
            moduleExports = hook(moduleExports)
          } catch (e) {
            log.error('Error executing lambda hook for datadog-lambda-js', e)
          }
        }
      }

      return moduleExports
    })
  }
}

module.exports = {
  _extractModuleRootAndHandler,
  _extractModuleNameAndHandlerPath,
  _getLambdaFilePaths,
  registerLambdaHook
}
