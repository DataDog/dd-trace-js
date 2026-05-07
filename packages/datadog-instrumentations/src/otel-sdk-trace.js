'use strict'

const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const { isFalse, isTrue } = require('../../dd-trace/src/util')
const { addHook } = require('./helpers/instrument')

if (isOtelSdkEnabled()) {
  addHook({
    name: '@opentelemetry/sdk-trace-node',
    file: 'build/src/NodeTracerProvider.js',
    versions: ['*'],
  }, (mod) => {
    shimmer.wrap(mod, 'NodeTracerProvider', () => {
      return tracer.TracerProvider
    })
    return mod
  })
}

function isOtelSdkEnabled () {
  // Datadog explicit opt-out wins over every OTel signal; check it first.
  const ddTraceOtelEnabled = getValueFromEnvSources('DD_TRACE_OTEL_ENABLED')
  if (isFalse(ddTraceOtelEnabled)) return false
  const otelSdkDisabled = getValueFromEnvSources('OTEL_SDK_DISABLED')
  if (isTrue(otelSdkDisabled)) return false
  return isTrue(ddTraceOtelEnabled) || isFalse(otelSdkDisabled)
}
