'use strict'

const path = require('path')
const Module = require('module')
const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const lambdaChannel = dc.tracingChannel('datadog:lambda:invoke')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const STREAM_RESPONSE = 'response'

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
    throw new Error('Malformed handler name: ' + handler)
  }
  return [match[1], match[2]] // [module, handler-path]
}

/**
 * Returns the parent object and final key for a nested handler path.
 *
 * @param {object} moduleExports the module's exports object.
 * @param {string} handlerPath dot-delimited path to the handler.
 * @returns {{ parent: object, key: string }|undefined}
 */
function _resolveHandlerParent (moduleExports, handlerPath) {
  const parts = handlerPath.split('.')
  let obj = moduleExports
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]]
    if (obj === undefined || obj === null) return undefined
  }
  return { parent: obj, key: parts[parts.length - 1] }
}

/**
 * Detects whether a handler is configured for response streaming.
 *
 * @param {Function} handler the Lambda handler function.
 * @returns {boolean}
 */
function _isResponseStream (handler) {
  return handler[HANDLER_STREAMING] !== undefined && handler[HANDLER_STREAMING] === STREAM_RESPONSE
}

/**
 * Wraps a Lambda handler to emit tracing channel events.
 *
 * @param {Function} originalHandler the original Lambda handler.
 * @param {string} handlerPath the dot-delimited handler path.
 * @returns {Function} the wrapped handler.
 */
function wrapLambdaHandler (originalHandler, handlerPath) {
  const isResponseStream = _isResponseStream(originalHandler)

  function wrappedHandler (event, contextOrStream, contextOrCallback) {
    var args = Array.prototype.slice.call(arguments)

    // For response streaming, args are (event, responseStream, context)
    // For normal invocation, args are (event, context, callback?)
    var context = isResponseStream ? contextOrCallback : contextOrStream

    var channelContext = {
      event: event,
      context: context,
      handlerPath: handlerPath,
      isResponseStream: isResponseStream,
    }

    return lambdaChannel.tracePromise(
      function () {
        return originalHandler.apply(null, args)
      },
      channelContext,
      null
    )
  }

  if (isResponseStream) {
    wrappedHandler[HANDLER_STREAMING] = STREAM_RESPONSE
  }

  return wrappedHandler
}

/**
 * Patches the handler exports after a module is loaded by file path.
 *
 * @param {object} moduleExports the loaded module's exports.
 * @param {string} handlerPath dot-delimited path to the handler within exports.
 */
function _patchHandlerExports (moduleExports, handlerPath) {
  var resolved = _resolveHandlerParent(moduleExports, handlerPath)
  if (resolved && typeof resolved.parent[resolved.key] === 'function') {
    shimmer.wrap(resolved.parent, resolved.key, function (original) {
      return wrapLambdaHandler(original, handlerPath)
    })
  }
}

// Determine which mode to use based on environment
var originalLambdaHandler = process.env.DD_LAMBDA_HANDLER
var currentHandler = process.env._HANDLER || ''
var usingHandlerWrapper = currentHandler.indexOf('handler-wrapper') !== -1

if (originalLambdaHandler && !usingHandlerWrapper) {
  // Legacy auto mode: DD_LAMBDA_HANDLER is set but _HANDLER was NOT overridden
  // to point to our handler-wrapper module (e.g., older layer setup without
  // dd_trace_wrapper, or custom integration). Fall back to Module._load patching.
  // Note: this does NOT work on nodejs22.x which uses ESM import() for handlers.
  var lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
  var moduleRootAndHandler = _extractModuleRootAndHandler(originalLambdaHandler)
  var moduleRoot = moduleRootAndHandler[0]
  var moduleAndHandler = moduleRootAndHandler[1]
  var moduleAndPath = _extractModuleNameAndHandlerPath(moduleAndHandler)
  var moduleName = moduleAndPath[0]
  var handlerPath = moduleAndPath[1]

  var taskRoot = lambdaTaskRoot || process.cwd()
  var lambdaStylePath = path.resolve(taskRoot, moduleRoot, moduleName)

  // Build a set of resolved paths the handler module could have (with extensions)
  var targetPaths = new Set()
  var extensions = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '']
  for (var i = 0; i < extensions.length; i++) {
    targetPaths.add(lambdaStylePath + extensions[i])
  }

  // Also try to resolve the path as Node would, to handle cases where the
  // extension or index.js resolution differs from our guesses
  try {
    targetPaths.add(require.resolve(lambdaStylePath))
  } catch (e) {
    // Module may not exist yet at instrumentation registration time
  }

  var originalLoad = Module._load
  var patched = false

  Module._load = function (request, parent, isMain) {
    var result = originalLoad.apply(this, arguments)

    if (!patched) {
      // Resolve the requested module to an absolute path to compare against targets
      var resolvedPath
      try {
        resolvedPath = Module._resolveFilename(request, parent, isMain)
      } catch (e) {
        return result
      }

      if (targetPaths.has(resolvedPath)) {
        patched = true
        _patchHandlerExports(result, handlerPath)
      }
    }

    return result
  }
} else if (!originalLambdaHandler) {
  // Manual mode: wrap the `datadog` export from datadog-lambda-js
  addHook({ name: 'datadog-lambda-js', versions: ['>=4'] }, function (datadogLambdaModule) {
    shimmer.wrap(datadogLambdaModule, 'datadog', function (originalDatadog) {
      return function (userHandler) {
        var wrappedUserHandler = wrapLambdaHandler(userHandler, 'handler')
        return originalDatadog(wrappedUserHandler)
      }
    })

    return datadogLambdaModule
  })
}

module.exports = {
  _extractModuleRootAndHandler,
  _extractModuleNameAndHandlerPath,
  wrapLambdaHandler,
}
