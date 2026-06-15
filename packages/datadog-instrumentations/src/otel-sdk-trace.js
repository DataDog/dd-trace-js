'use strict'

const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
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
  // skipDefault: an unset option must stay undefined so the OTel signal still decides — the
  // registered defaults (false / true) would otherwise force-disable before that check.
  const ddTraceOtelEnabled = getValueFromEnvSources('DD_TRACE_OTEL_ENABLED', true)
  if (ddTraceOtelEnabled === false) return false
  const otelSdkDisabled = getValueFromEnvSources('OTEL_SDK_DISABLED', true)
  if (otelSdkDisabled) return false
  return ddTraceOtelEnabled || otelSdkDisabled === false
}
