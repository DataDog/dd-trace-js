'use strict'

const path = require('path')

/**
 * Lambda handler wrapper module.
 *
 * The dd_trace_wrapper shell script overrides _HANDLER to point here, so the
 * Lambda runtime loads this module instead of the customer's handler. This
 * module resolves the original handler from DD_LAMBDA_HANDLER, loads it, wraps
 * it with tracing channel events via wrapLambdaHandler, and re-exports it.
 *
 * This approach is more reliable than Module._load patching because the
 * nodejs22.x Lambda runtime uses ESM import() to load handlers, which
 * bypasses Module._load entirely.
 */

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')

const fullHandler = process.env.DD_LAMBDA_HANDLER
if (!fullHandler) {
  throw new Error(
    'dd-trace handler-wrapper: DD_LAMBDA_HANDLER is not set. ' +
    'Ensure the dd_trace_wrapper script is used via AWS_LAMBDA_EXEC_WRAPPER.'
  )
}

const FUNCTION_EXPR = /^([^.]*)\.(.*)$/
const taskRoot = process.env.LAMBDA_TASK_ROOT || process.cwd()

// Parse handler string: "dir/index.handler" -> module="dir/index", handlerPath="handler"
// Parse handler string: "index.nested.handler" -> module="index", handlerPath="nested.handler"
const handlerBasename = path.basename(fullHandler)
const moduleRoot = fullHandler.slice(0, Math.max(0, fullHandler.indexOf(handlerBasename)))
const match = handlerBasename.match(FUNCTION_EXPR)
if (!match || match.length !== 3) {
  throw new Error('dd-trace handler-wrapper: Malformed DD_LAMBDA_HANDLER: ' + fullHandler)
}
const moduleName = match[1]
const handlerPath = match[2]
const modulePath = path.resolve(taskRoot, moduleRoot, moduleName)

// Load the original handler module
const handlerModule = require(modulePath)

// Resolve the handler function through the dot-delimited path
function resolveHandler (obj, dotPath) {
  const parts = dotPath.split('.')
  let current = obj
  for (let i = 0; i < parts.length; i++) {
    if (current === undefined || current === null) return undefined
    current = current[parts[i]]
  }
  return current
}

const originalHandler = resolveHandler(handlerModule, handlerPath)
if (typeof originalHandler !== 'function') {
  throw new Error(
    'dd-trace handler-wrapper: Handler "' + handlerPath + '" in module "' + modulePath +
    '" is not a function (got ' + typeof originalHandler + ')'
  )
}

// Wrap the handler with tracing channel events.
// The instrumentation module is already loaded at this point (dd-trace/init ran
// via NODE_OPTIONS --require before the Lambda runtime loaded this module).
const { wrapLambdaHandler } = require('../../../datadog-instrumentations/src/lambda')
exports.handler = wrapLambdaHandler(originalHandler, handlerPath)

// Preserve streaming configuration if present
if (originalHandler[HANDLER_STREAMING] !== undefined) {
  exports.handler[HANDLER_STREAMING] = originalHandler[HANDLER_STREAMING]
}
