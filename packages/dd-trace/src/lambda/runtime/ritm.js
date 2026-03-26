'use strict'

/**
 * Register Lambda instrumentation hooks.
 *
 * This simply requires the Lambda instrumentation module which uses addHook
 * to register its own hooks. The instrumentation module handles both auto
 * mode (DD_LAMBDA_HANDLER set) and manual mode (datadog-lambda-js wrapper).
 */
const registerLambdaHook = () => {
  require('../../../../datadog-instrumentations/src/lambda')
}

module.exports = {
  registerLambdaHook,
}
