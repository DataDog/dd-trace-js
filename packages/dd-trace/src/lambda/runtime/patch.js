'use strict'

const path = require('path')

const { withTimeoutMonitor, wrapLambdaHandler } = require('../handler')
const { addHook } = require('../../../../datadog-instrumentations/src/helpers/instrument')
const shimmer = require('../../../../datadog-shimmer')
const { isTrue } = require('../../util')
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

/**
 * Whether dd-trace creates the `aws.lambda` invocation span. Transitional, default off.
 *
 * While the pre-migration datadog-lambda-js still owns the invocation span, dd-trace must not
 * create a second one: the released shim does not know
 * `Symbol.for('dd-trace.lambda.wrapped')`, and dd-trace deliberately does not claim the shim's
 * `_ddWrapped` marker, so both would wrap and export two root `aws.lambda` spans in two separate
 * traces. Off preserves the pre-PR3 division of ownership — dd-trace's Lambda support was timeout
 * monitoring only and never produced a span.
 *
 * Enabling it is for migration testing and knowingly double-spans against the old shim. The gate
 * goes away once the shim delegates to `dd-trace/lambda` and the marker makes wrapping idempotent.
 *
 * Migration-internal knob: registered in supported-configurations.json (env access validation
 * requires it) but intentionally not mapped to a customer-facing config option.
 */
function ddTraceOwnsInvocationSpan () {
  return isTrue(getValueFromEnvSources('DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS'))
}

/**
 * Composes the two independent concerns, innermost first.
 *
 * Timeout monitoring always applies; span creation is gated. The monitor has to sit *inside* the
 * span-creating wrapper so the span is active when its timer fires.
 *
 * @param {Function} lambdaHandler Customer handler.
 * @param {Record<string, unknown>} [config] Per-handler overrides.
 * @returns {Function} Instrumented handler.
 */
function instrumentLambdaHandler (lambdaHandler, config) {
  return ddTraceOwnsInvocationSpan() ? wrapLambdaHandler(lambdaHandler, config) : withTimeoutMonitor(lambdaHandler)
}

/** @param {Function} datadogHandler */
function patchDatadogLambdaHandler (datadogHandler) {
  return function monitoredDatadog (userHandler, ...args) {
    return datadogHandler.call(this, instrumentLambdaHandler(userHandler, args[0]), ...args)
  }
}

/** @param {string} handlerPath */
function patchLambdaModule (handlerPath) {
  return lambdaModule => {
    shimmer.wrap(lambdaModule, handlerPath, patchLambdaHandler)
    return lambdaModule
  }
}

/** @param {Function} lambdaHandler */
function patchLambdaHandler (lambdaHandler) {
  return instrumentLambdaHandler(lambdaHandler)
}

const lambdaTaskRoot = getEnvironmentVariable('LAMBDA_TASK_ROOT')
const originalLambdaHandler = getValueFromEnvSources('DD_LAMBDA_HANDLER')

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
