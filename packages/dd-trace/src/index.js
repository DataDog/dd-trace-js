'use strict'

const { getEnvironmentVariable, getValueFromEnvSources } = require('./config/helper')
const { isTrue } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

// skipDefault: distinguish an unset DD_TRACE_ENABLED (fall back to the OTel signal) from an
// explicit value; the registered default would otherwise mask the OTEL_TRACES_EXPORTER check.
const ddTraceEnabled = getValueFromEnvSources('DD_TRACE_ENABLED', true)
const agentlessTracingEnabled = getValueFromEnvSources('DD_AGENTLESS_ENABLED') ||
  isTrue(getEnvironmentVariable('_DD_APM_TRACING_AGENTLESS_ENABLED'))
const ddTraceDisabled = ddTraceEnabled === undefined
  ? !agentlessTracingEnabled && getValueFromEnvSources('OTEL_TRACES_EXPORTER') === 'none'
  : ddTraceEnabled === false

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
