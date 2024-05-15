'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')

const otelSdkEnabled = process.env.DD_TRACE_OTEL_ENABLED ||
process.env.OTEL_SDK_DISABLED
  ? !process.env.OTEL_SDK_DISABLED
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
