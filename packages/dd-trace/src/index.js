'use strict'

const { getValueFromEnvSources } = require('./config/helper')
const { isFalse, isTrue } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

const ddTraceDisabled = getValueFromEnvSources('DD_TRACE_ENABLED')
  ? isFalse(getValueFromEnvSources('DD_TRACE_ENABLED'))
  : String(getValueFromEnvSources('OTEL_TRACES_EXPORTER')).toLowerCase() === 'none'
const shouldUseProxyWhenTracingDisabled =
  isTrue(getValueFromEnvSources('DD_DYNAMIC_INSTRUMENTATION_ENABLED')) ||
  isTrue(getValueFromEnvSources('DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED'))

module.exports = (ddTraceDisabled && !shouldUseProxyWhenTracingDisabled) || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
