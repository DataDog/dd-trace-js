'use strict'

const { getValueFromEnvSources } = require('./config/helper')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceEnabled = getValueFromEnvSources('DD_TRACE_ENABLED')
const ddTraceDisabled = ddTraceEnabled === undefined
  ? getValueFromEnvSources('OTEL_TRACES_EXPORTER') === 'none'
  : ddTraceEnabled === false

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
