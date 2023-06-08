'use strict'

const tracer = require('dd-trace').init()

const { TracerProvider } = tracer

const provider = new TracerProvider()
provider.register()

const otelTracer = provider.getTracer(
  'my-service-tracer'
)

otelTracer.startActiveSpan('otel-sub', otelSpan => {
  setImmediate(() => {
    otelSpan.end()
  })
})
