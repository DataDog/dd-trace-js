'use strict'

const tracer = require('dd-trace').init()

const { TracerProvider } = tracer

const provider = new TracerProvider()
provider.register()

const ot = require('@opentelemetry/api')

const otelTracer = ot.trace.getTracer(
  'my-service-tracer'
)

otelTracer.startActiveSpan('otel-sub', otelSpan => {
  setImmediate(() => {
    otelSpan.end()
  })
})
