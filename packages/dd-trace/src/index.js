'use strict'

const { isFalse } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = process.env.DD_TRACE_ENABLED
  ? isFalse(process.env.DD_TRACE_ENABLED)
  : String(process.env.OTEL_TRACES_EXPORTER).toLowerCase() === 'none'

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
