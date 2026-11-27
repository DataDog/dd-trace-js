'use strict'

const TIMEOUT = Number(process.env.TIMEOUT || 0)

let ot = process.argv[2] === 'cached-api-first' ? require('@opentelemetry/api') : undefined
const tracer = require('dd-trace').init()
const assert = require('node:assert/strict')

if (process.argv[2] === 'dependency-api-first') {
  const dependencyRequire = require('node:module').createRequire(process.argv[3])
  dependencyRequire('@opentelemetry/api')
}

if (process.argv[2] === 'api-first' || process.argv[2] === 'diag-first') {
  ot = require('@opentelemetry/api')
  if (process.argv[2] === 'diag-first') {
    ot.diag.setLogger({ error () {}, warn () {}, info () {}, debug () {}, verbose () {} })
  }
}

const { TracerProvider } = tracer

const provider = new TracerProvider()
provider.register()

ot ??= require('@opentelemetry/api')

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
  assert.ok(otelSpan.isRecording())
  assert.ok(ot.trace.isSpanContextValid(otelSpan.spanContext()))
  assert.strictEqual(ot.trace.getActiveSpan(), otelSpan)
  const carrier = /** @type {Record<string, string>} */ ({})
  ot.propagation.inject(ot.context.active(), carrier)

  const activeSpanContext = otelSpan.spanContext()
  const activeTraceState = activeSpanContext.traceState
  const extractedContext = ot.propagation.extract(ot.ROOT_CONTEXT, carrier)
  const extractedSpanContext = ot.trace.getSpanContext(extractedContext)

  assert.ok(carrier.traceparent)
  assert.strictEqual(activeTraceState.serialize(), carrier.tracestate)
  assert.strictEqual(Object.getPrototypeOf(activeTraceState), Object.getPrototypeOf(ot.createTraceState()))
  assert.ok(extractedSpanContext)
  assert.strictEqual(extractedSpanContext.traceId, activeSpanContext.traceId)
  assert.strictEqual(extractedSpanContext.spanId, activeSpanContext.spanId)
  assert.strictEqual(extractedSpanContext.traceFlags, activeSpanContext.traceFlags)
  assert.strictEqual(extractedSpanContext.traceState.serialize(), activeTraceState.serialize())

  setImmediate(() => {
    otelSpan.end(startTime + 50)

    // Allow the process to be held open to gather telemetry metrics
    setTimeout(() => {}, TIMEOUT)
  })
})
