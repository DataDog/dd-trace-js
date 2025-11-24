'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('tap').mocha

require('../setup/core')

const SpanContext = require('../../src/opentelemetry/span_context')
const DDSpanContext = require('../../src/opentracing/span_context')
const id = require('../../src/id')
const { USER_REJECT, AUTO_REJECT, AUTO_KEEP, USER_KEEP } = require('../../../../ext/priority')
const TraceState = require('../../src/opentracing/propagation/tracestate')

describe('OTel Span Context', () => {
  it('should create new dd context if none given', () => {
    const context = new SpanContext()
    assert.ok(context._ddContext instanceof DDSpanContext)
  })

  it('should accept given dd context as-is', () => {
    const spanId = id()
    const ddContext = new DDSpanContext({
      traceId: spanId,
      spanId
    })
    const context = new SpanContext(ddContext)
    assert.strictEqual(context._ddContext, ddContext)
  })

  it('should accept object to build new dd context', () => {
    const spanId = id()
    const context = new SpanContext({
      traceId: spanId,
      spanId
    })
    const ddContext = context._ddContext
    assert.ok(ddContext instanceof DDSpanContext)
    assert.strictEqual(ddContext._traceId, spanId)
    assert.strictEqual(ddContext._spanId, spanId)
  })

  it('should get trace id as hex', () => {
    const traceId = id()
    const context = new SpanContext({
      traceId
    })
    // normalize to 128 bit since that is what otel expects
    const normalizedTraceId = traceId.toString(16).padStart(32, '0')
    assert.strictEqual(context.traceId, normalizedTraceId)
  })

  it('should get span id as hex', () => {
    const spanId = id()
    const context = new SpanContext({
      spanId
    })
    assert.strictEqual(context.spanId, spanId.toString(16))
  })

  it('should map sampling priority to trace flags', () => {
    const checks = [
      [USER_REJECT, 0],
      [AUTO_REJECT, 0],
      [AUTO_KEEP, 1],
      [USER_KEEP, 1]
    ]

    for (const [priority, traceFlags] of checks) {
      const spanId = id()
      const context = new SpanContext({
        traceId: spanId,
        spanId,
        sampling: {
          priority
        }
      })
      assert.strictEqual(context.traceFlags, traceFlags)
    }
  })

  it('should get trace state as string', () => {
    const tracestate = new TraceState()
    tracestate.forVendor('dd', vendor => {
      vendor.set('foo', 'bar')
    })

    const context = new SpanContext({
      tracestate
    })

    assert.strictEqual(context.traceState.serialize(), 'dd=foo:bar')
  })
})
