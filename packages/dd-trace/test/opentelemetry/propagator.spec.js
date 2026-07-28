'use strict'

const assert = require('node:assert')

const { ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter, trace } = require('@opentelemetry/api')

const id = require('../../src/id')
const DatadogSpanContext = require('../../src/opentracing/span_context')
const DatadogPropagator = require('../../src/opentelemetry/propagator')
const SpanContext = require('../../src/opentelemetry/span_context')

describe('OpenTelemetry DatadogPropagator', () => {
  const traceId = '1234567890abcdef'
  const spanId = 'fedcba0987654321'

  it('extracts Datadog headers before W3C headers', () => {
    const propagator = new DatadogPropagator()
    const extracted = propagator.extract(ROOT_CONTEXT, {
      'x-datadog-trace-id': BigInt(`0x${traceId}`).toString(),
      'x-datadog-parent-id': BigInt(`0x${spanId}`).toString(),
      'x-datadog-sampling-priority': '1',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    }, defaultTextMapGetter)

    const context = trace.getSpanContext(extracted)
    assert.strictEqual(context.traceId, traceId.padStart(32, '0'))
    assert.strictEqual(context.spanId, spanId)
    assert.ok(context._ddContext)
  })

  it('injects configured Datadog and W3C headers from a Datadog context', () => {
    const propagator = new DatadogPropagator()
    const ddContext = new DatadogSpanContext({
      traceId: id(traceId, 16),
      spanId: id(spanId, 16),
      sampling: { priority: 1 },
    })
    const context = trace.setSpanContext(ROOT_CONTEXT, new SpanContext(ddContext))
    const carrier = {}

    propagator.inject(context, carrier, defaultTextMapSetter)

    assert.strictEqual(carrier['x-datadog-trace-id'], BigInt(`0x${traceId}`).toString())
    assert.strictEqual(carrier['x-datadog-parent-id'], BigInt(`0x${spanId}`).toString())
    assert.strictEqual(carrier.traceparent, `00-${traceId.padStart(32, '0')}-${spanId}-01`)
  })

  it('falls back to W3C extraction when Datadog headers are absent', () => {
    const propagator = new DatadogPropagator()
    const extracted = propagator.extract(ROOT_CONTEXT, {
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    }, defaultTextMapGetter)

    const context = trace.getSpanContext(extracted)
    assert.strictEqual(context.traceId, '11111111111111111111111111111111')
    assert.strictEqual(context.spanId, '2222222222222222')
    assert.strictEqual(context.traceFlags, 1)
    assert.ok(context._ddContext)
  })
})
