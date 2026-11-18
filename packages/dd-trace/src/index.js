'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')
const { isTrue } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

// skipDefault: distinguish an unset DD_TRACE_ENABLED (fall back to the OTel settings) from an
// explicit value; the registered default would otherwise mask the OTel checks.
const ddTraceEnabled = getValueFromEnvSources('DD_TRACE_ENABLED', true)
const agentlessTracingEnabled = getValueFromEnvSources('DD_AGENTLESS_ENABLED') ||
  isTrue(getEnvironmentVariable('_DD_APM_TRACING_AGENTLESS_ENABLED'))
// OTEL_SDK_DISABLED turns the whole SDK off, while OTEL_TRACES_EXPORTER only selects a trace
// transport, which agentless mode replaces.
const ddTraceDisabled = ddTraceEnabled === undefined
  ? getValueFromEnvSources('OTEL_SDK_DISABLED') ||
    (!agentlessTracingEnabled && getValueFromEnvSources('OTEL_TRACES_EXPORTER') === 'none')
  : ddTraceEnabled === false

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
