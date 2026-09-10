'use strict'

const TIMEOUT = Number(process.env.TIMEOUT || 0)

const tracer = require('dd-trace').init()
const assert = require('node:assert/strict')

const { TracerProvider } = tracer

const provider = new TracerProvider()
provider.register()

const ot = require('@opentelemetry/api')

const otelTracer = ot.trace.getTracer(
  'my-service-tracer'
)

const startTime = Date.now()

otelTracer.startActiveSpan('otel-sub', {
  attributes: {
    'test.attribute': 'value',
  },
  startTime,
}, /** @param {import('@opentelemetry/api').Span} otelSpan */ otelSpan => {
  const carrier = /** @type {Record<string, string>} */ ({})
  ot.propagation.inject(ot.context.active(), carrier)

  const activeSpanContext = otelSpan.spanContext()
  const activeTraceState = activeSpanContext.traceState
  const extractedContext = ot.propagation.extract(ot.ROOT_CONTEXT, carrier)
  const extractedSpanContext = ot.trace.getSpanContext(extractedContext)

  assert.ok(carrier.traceparent)
  assert.strictEqual(activeTraceState.serialize(), '')
  if (ot.createTraceState) {
    assert.strictEqual(Object.getPrototypeOf(activeTraceState), Object.getPrototypeOf(ot.createTraceState()))
  }
  assert.ok(extractedSpanContext)
  assert.strictEqual(extractedSpanContext.traceId, activeSpanContext.traceId)
  assert.strictEqual(extractedSpanContext.spanId, activeSpanContext.spanId)
  assert.strictEqual(extractedSpanContext.traceFlags, activeSpanContext.traceFlags)

  setImmediate(() => {
    otelSpan.end(startTime + 50)

    // Allow the process to be held open to gather telemetry metrics
    setTimeout(() => {}, TIMEOUT)
  })
})
