'use strict'

const { isFalse } = require('./util')
const { getResolvedEnv } = require('./config-env-sources')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = getResolvedEnv('DD_TRACE_ENABLED')
  ? isFalse(getResolvedEnv('DD_TRACE_ENABLED'))
  : String(getResolvedEnv('OTEL_TRACES_EXPORTER')).toLowerCase() === 'none'

module.exports = ddTraceDisabled || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
