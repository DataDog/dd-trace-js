'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const { isFalse } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = getEnvironmentVariable('DD_TRACE_ENABLED')
  ? isFalse(getEnvironmentVariable('DD_TRACE_ENABLED'))
  : String(getEnvironmentVariable('OTEL_TRACES_EXPORTER')).toLowerCase() === 'none'

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
