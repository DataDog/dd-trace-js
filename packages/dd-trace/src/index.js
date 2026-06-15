'use strict'

const { getValueFromEnvSources } = require('./config/helper')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

// skipDefault: distinguish an unset DD_TRACE_ENABLED (fall back to the OTel signal) from an
// explicit value; the registered default would otherwise mask the OTEL_TRACES_EXPORTER check.
const ddTraceEnabled = getValueFromEnvSources('DD_TRACE_ENABLED', true)
const ddTraceDisabled = ddTraceEnabled === undefined
  ? getValueFromEnvSources('OTEL_TRACES_EXPORTER') === 'none'
  : ddTraceEnabled === false

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
