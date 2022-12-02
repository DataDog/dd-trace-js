/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Modifications copyright 2022 Datadog, Inc.
 *
 * Some functions are part of aws-lambda-nodejs-runtime-interface-client
 * https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/main/src/utils/UserFunction.ts
 */
'use strict'

const fs = require('fs')
const path = require('path')

const Hook = require('../../../packages/datadog-instrumentations/src/helpers/hook')
const instrumentations = require('../../../packages/datadog-instrumentations/src/helpers/instrumentations')
const log = require('../../../packages/dd-trace/src/log')

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
  const moduleRoot = fullHandler.substring(0, fullHandler.indexOf(handlerString))

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
 * Returns the correct path of the file to be patched
 * when required.
 *
 * @param {*} lambdaStylePath the path comprised of the `LAMBDA_TASK_ROOT`,
 * the root of the module of the Lambda handler, and the module name.
 * @returns the lambdaStylePath with the appropiate extension for the hook.
 */
function _getLambdaFilePath (lambdaStylePath) {
  let lambdaFilePath = lambdaStylePath
  if (fs.existsSync(lambdaStylePath + '.js')) {
    lambdaFilePath += '.js'
  } else if (fs.existsSync(lambdaStylePath + '.mjs')) {
    lambdaFilePath += '.mjs'
  } else if (fs.existsSync(lambdaStylePath + '.cjs')) {
    lambdaFilePath += '.cjs'
  }
  return lambdaFilePath
}

/**
 * Register a hook for the Lambda handler to be executed when
 * the file is required.
 */
const registerLambdaHook = () => {
  const lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
  const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER

  const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler)
  const [_module] = _extractModuleNameAndHandlerPath(moduleAndHandler)

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module)
  const lambdaFilePath = _getLambdaFilePath(lambdaStylePath)
  Hook([lambdaFilePath], (moduleExports) => {
    require('./patch')

    for (const { hook } of instrumentations[lambdaFilePath]) {
      try {
        moduleExports = hook(moduleExports)
      } catch (e) {
        log.error(e)
      }
    }

    return moduleExports
  })
}

module.exports = {
  _extractModuleRootAndHandler,
  _extractModuleNameAndHandlerPath,
  _getLambdaFilePath,
  registerLambdaHook
}
