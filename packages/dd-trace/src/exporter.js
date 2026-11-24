'use strict'

const fs = require('fs')
const exporters = require('../../../ext/exporters')
const constants = require('./constants')

module.exports = function getExporter (name) {
  switch (name) {
    case exporters.LLMOBS:
      return usesLambdaLogExporter() ? require('./exporters/log') : require('./exporters/llmobs')
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
    case exporters.JEST_WORKER:
    case exporters.CUCUMBER_WORKER:
    case exporters.MOCHA_WORKER:
    case exporters.PLAYWRIGHT_WORKER:
    case exporters.VITEST_WORKER:
      return require('./ci-visibility/exporters/test-worker')
  }

  return usesLambdaLogExporter() ? require('./exporters/log') : require('./exporters/agent')
}

function usesLambdaLogExporter () {
  const { IS_AWS_LAMBDA } = require('./serverless')
  return IS_AWS_LAMBDA &&
    !fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH) &&
    !fs.existsSync(constants.DATADOG_MINI_AGENT_PATH)
}

/**
 * Whether the tracer effectively uses OTLP for APM spans.
 * Test Optimization and Electron do not support OTLP even when `OTEL_TRACES_EXPORTER` is `otlp`.
 *
 * @param {import('./config')} config
 */
function usesOtlpTraceExporter (config) {
  return config.OTEL_TRACES_EXPORTER === 'otlp' &&
    !config.isCiVisibility &&
    config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER !== exporters.ELECTRON &&
    config.tracing.DD_TRACE_EXPERIMENTAL_EXPORTER !== exporters.AGENTLESS
}

module.exports.usesOtlpTraceExporter = usesOtlpTraceExporter
