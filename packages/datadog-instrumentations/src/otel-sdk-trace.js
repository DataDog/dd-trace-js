'use strict'

const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const { addHook } = require('./helpers/instrument')

const otelSdkEnabled = getValueFromEnvSources('DD_TRACE_OTEL_ENABLED') ||
getValueFromEnvSources('OTEL_SDK_DISABLED')
  ? !getValueFromEnvSources('OTEL_SDK_DISABLED')
  : undefined

if (otelSdkEnabled) {
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
