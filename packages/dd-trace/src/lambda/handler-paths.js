/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Modifications copyright 2022 Datadog, Inc.
 *
 * Some functions are part of aws-lambda-nodejs-runtime-interface-client
 * https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/v2.1.0/src/utils/UserFunction.ts
 */
'use strict'

const path = require('path')

/**
 * Example: `'./api/src/index.nested.handler'` → `['./api/src/', 'index.nested.handler']`.
 *
 * @param {string} fullHandler
 */
function extractModuleRootAndHandler (fullHandler) {
  const handlerString = path.basename(fullHandler)
  const moduleRoot = fullHandler.slice(0, Math.max(0, fullHandler.indexOf(handlerString)))
  return [moduleRoot, handlerString]
}

/**
 * Example: `'index.nested.handler'` → `['index', 'nested.handler']`.
 *
 * @param {string} handler
 * @throws {Error} When the handler is not of the form `<module>.<path>`.
 */
function extractModuleNameAndHandlerPath (handler) {
  const match = handler.match(/^([^.]*)\.(.*)$/)
  if (!match || match.length !== 3) {
    throw new Error(`Malformed handler name: ${handler}`)
  }
  return [match[1], match[2]]
}

/**
 * @param {string} lambdaStylePath `LAMBDA_TASK_ROOT` joined with the module root and module name.
 */
function getLambdaFilePaths (lambdaStylePath) {
  return [
    `${lambdaStylePath}.js`,
    `${lambdaStylePath}.mjs`,
    `${lambdaStylePath}.cjs`,
  ]
}

module.exports = {
  extractModuleRootAndHandler,
  extractModuleNameAndHandlerPath,
  getLambdaFilePaths,
}
