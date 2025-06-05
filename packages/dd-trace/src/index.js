'use strict'

const { isFalse } = require('./util')
const { getConfiguration } = require('../../dd-trace/src/config-helper')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = getConfiguration('DD_TRACE_ENABLED')
  ? isFalse(getConfiguration('DD_TRACE_ENABLED'))
  : String(getConfiguration('OTEL_TRACES_EXPORTER')).toLowerCase() === 'none'

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
