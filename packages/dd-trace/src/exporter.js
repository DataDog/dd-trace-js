'use strict'

const fs = require('fs')
const exporters = require('../../../ext/exporters')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const constants = require('./constants')
const { isTrue } = require('./util')

module.exports = function getExporter (name) {
  switch (name) {
    case exporters.ELECTRON:
      return require('./exporters/electron')
    case exporters.LOG:
      return require('./exporters/log')
    case exporters.AGENT:
      return require('./exporters/agent')
    case exporters.AGENTLESS:
      return require('./exporters/agentless')
    case exporters.DATADOG:
      return require('./ci-visibility/exporters/agentless')
    case exporters.AGENT_PROXY:
      return require('./ci-visibility/exporters/agent-proxy')
    case exporters.CI_VALIDATION:
      if (hasCiValidationEnvironment()) return require('./ci-visibility/exporters/ci-validation')
      break
    case exporters.JEST_WORKER:
    case exporters.CUCUMBER_WORKER:
    case exporters.MOCHA_WORKER:
    case exporters.PLAYWRIGHT_WORKER:
    case exporters.VITEST_WORKER:
      return require('./ci-visibility/exporters/test-worker')
  }

  return usesLambdaLogExporter() ? require('./exporters/log') : require('./exporters/agent')
}

/**
 * Whether spans have to be written to the Lambda log for the Forwarder to pick up, which is the
 * case in a Lambda with neither the Datadog extension nor the mini agent. Nothing else can reach
 * the backend from there, so this transport must not be replaced.
 *
 * @returns {boolean}
 */
function usesLambdaLogExporter () {
  if (getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') === undefined) return false

  return !fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH) &&
    !fs.existsSync(constants.DATADOG_MINI_AGENT_PATH)
}

function hasCiValidationEnvironment () {
  return isTrue(getEnvironmentVariable('_DD_TEST_OPTIMIZATION_VALIDATION_MODE')) &&
    getEnvironmentVariable('_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE') &&
    getEnvironmentVariable('_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR')
}

/**
 * Whether the OTLP export that OTel semantics mode forces has to yield to the Lambda log
 * transport: true in a Lambda that can only reach the backend through its log, and only while the
 * caller has not pointed OTLP at a collector of their own.
 *
 * @returns {boolean}
 */
function requiresLambdaLogExporter () {
  if (!usesLambdaLogExporter()) return false

  // `createOtlpTraceExporter` reads the trace-specific endpoint and `Config` fills in a default
  // for it, so only the environment shows whether the caller chose one.
  return getEnvironmentVariable('OTEL_EXPORTER_OTLP_ENDPOINT') === undefined &&
    getEnvironmentVariable('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') === undefined
}

module.exports.usesLambdaLogExporter = usesLambdaLogExporter
module.exports.requiresLambdaLogExporter = requiresLambdaLogExporter
