'use strict'

process.env.DD_TRACE_OTEL_ENABLED = '1'

require('dd-trace').init()

const opentelemetry = require('@opentelemetry/sdk-node')

// @opentelemetry/sdk-node 0.220+ hands span processors to the provider
// constructor rather than calling addSpanProcessor, so a user processor only
// receives onStart/onEnd if the dd-trace TracerProvider consumes
// config.spanProcessors. Model a real user's exporter as a custom processor and
// fail loudly if it never sees the span the tracer produced.
let started = false
let ended = false

const userSpanProcessor = {
  onStart () { started = true },
  onEnd () { ended = true },
  forceFlush () { return Promise.resolve() },
  shutdown () { return Promise.resolve() },
}

const sdk = new opentelemetry.NodeSDK({
  spanProcessors: [userSpanProcessor],
})

sdk.start()

const otelTracer = opentelemetry.api.trace.getTracer('my-service-tracer')

otelTracer.startActiveSpan('otel-sub', otelSpan => {
  setImmediate(() => {
    otelSpan.end()

    if (!started || !ended) {
      // eslint-disable-next-line no-console
      console.error(`user span processor missed the span (onStart=${started}, onEnd=${ended})`)
      process.exit(1)
    }
  })
})
