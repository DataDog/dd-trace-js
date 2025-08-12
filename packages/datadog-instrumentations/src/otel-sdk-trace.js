'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

const otelSdkEnabled = getEnvironmentVariable('DD_TRACE_OTEL_ENABLED') ||
getEnvironmentVariable('OTEL_SDK_DISABLED')
  ? !getEnvironmentVariable('OTEL_SDK_DISABLED')
  : undefined

if (otelSdkEnabled) {
  addHook({
    name: '@opentelemetry/sdk-trace-node',
    file: 'build/src/NodeTracerProvider.js',
    versions: ['*']
  }, (mod) => {
    shimmer.wrap(mod, 'NodeTracerProvider', () => {
      return tracer.TracerProvider
    })
    return mod
  })
}
