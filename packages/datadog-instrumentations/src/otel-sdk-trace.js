'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { getResolvedEnv } = require('../../dd-trace/src/config-env-sources')

const otelSdkEnabled = getResolvedEnv('DD_TRACE_OTEL_ENABLED') ||
getResolvedEnv('OTEL_SDK_DISABLED')
  ? !getResolvedEnv('OTEL_SDK_DISABLED')
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
