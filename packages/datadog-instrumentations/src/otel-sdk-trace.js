'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getConfiguration } = require('../../dd-trace/src/config-helper')

const otelSdkEnabled = getConfiguration('DD_TRACE_OTEL_ENABLED') ||
getConfiguration('OTEL_SDK_DISABLED')
  ? !getConfiguration('OTEL_SDK_DISABLED')
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
