'use strict'

const shimmer = require('../../datadog-shimmer')
const tracer = require('../../dd-trace')
const { isOtelSdkEnabled } = require('../../dd-trace/src/config/helper')
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

  // As of @opentelemetry/sdk-node 0.220.0, NodeSDK builds its provider from
  // @opentelemetry/sdk-trace's TracerProvider instead of sdk-trace-node's
  // NodeTracerProvider, so the hook above no longer intercepts it. Wrap this
  // export too, otherwise DD_TRACE_OTEL_ENABLED spans never reach the tracer.
  addHook({
    name: '@opentelemetry/sdk-trace',
    file: 'build/src/TracerProvider.js',
    versions: ['*'],
  }, (mod) => {
    shimmer.wrap(mod, 'TracerProvider', () => {
      return tracer.TracerProvider
    })
    return mod
  })
}
