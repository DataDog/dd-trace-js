'use strict'

process.env.DD_TRACE_OTEL_ENABLED = '1'

require('dd-trace').init()

const opentelemetry = require('@opentelemetry/sdk-node')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')

const sdk = new opentelemetry.NodeSDK({
  traceExporter: new JaegerExporter()
})

sdk.start()

const otelTracer = opentelemetry.api.trace.getTracer(
  'my-service-tracer'
)

otelTracer.startActiveSpan('otel-sub', otelSpan => {
  setImmediate(() => {
    otelSpan.end()
  })
})
