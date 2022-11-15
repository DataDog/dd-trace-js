'use strict'

const fs = require('fs')
const path = require('path')

const Hook = require('../../packages/datadog-instrumentations/src/helpers/hook')
const instrumentations = require('../../packages/datadog-instrumentations/src/helpers/instrumentations')

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
function _extractModuleRootAndHandler(fullHandler) {
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
function _extractModuleNameAndHandlerPath(handler) {
  const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
  const match = handler.match(FUNCTION_EXPR)
  if (!match || match.length != 3) {
    // Malformed Handler Name
    return // TODO: throw error
  }
  return [match[1], match[2]] // [module, handler-path]
}

/**
 * Resolve the user's handler function from its module.
 * 
 * @param {*} userApp 
 * @param {string} handlerPath 
 * @returns the handler function if exists, else `undefined`.
 * 
 * ```js
 * const userApp = { module: { nested: { handler: () => {} } } }
 * const handlerPath = 'module.nested.handler'
 * _resolveHandler(userApp, handlerPath) 
 * // => () => {}
 * ```
 */
function _resolveHandler(userApp, handlerPath) {
  return _getNestedProperty(userApp, handlerPath)
}

/**
 * Given an object with nested properties, return the desired
 * nested property.
 * 
 * @param {*} object an object with nested properties.
 * @param {string} nestedProperty the property to return its value.
 * @returns the value of the nested property if exists, else `undefined`.
 */
const _getNestedProperty = (object, nestedProperty) => {
  return nestedProperty.split('.').reduce((nested, key) => {
    return nested && nested[key]
  }, object)
}

exports.registerLambdaHook = () => {
  const lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
  const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER

  const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler)
  const [_module] = _extractModuleNameAndHandlerPath(moduleAndHandler)

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module)
  // TODO: identify which file is actually being require
  // extensionless? .js? .mjs? .cjs? node style path?
  const lambdaFilePath = lambdaStylePath + '.js'

  if (fs.existsSync(lambdaFilePath)) { // remove this line by identifying file?
    Hook([lambdaFilePath], (moduleExports) => {
      require('./patch')

      for (const { hook } of instrumentations[lambdaFilePath]) {
        try {
          moduleExports = hook(moduleExports)
        } catch (error) {
          // TODO: throw error
        }
      }
    
      return moduleExports
    })
  }
}

exports._extractModuleRootAndHandler = _extractModuleRootAndHandler 
exports._extractModuleNameAndHandlerPath = _extractModuleNameAndHandlerPath
exports._resolveHandler = _resolveHandler 