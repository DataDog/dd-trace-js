'use strict'

const { isFalse } = require('./util')
const { getValueFromEnvSources } = require('./config-helper')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = getValueFromEnvSources('DD_TRACE_ENABLED')
  ? isFalse(getValueFromEnvSources('DD_TRACE_ENABLED'))
  : String(getValueFromEnvSources('OTEL_TRACES_EXPORTER')).toLowerCase() === 'none'

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
