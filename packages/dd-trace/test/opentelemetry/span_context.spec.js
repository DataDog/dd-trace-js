'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const SpanContext = require('../../src/opentelemetry/span_context')
const DDSpanContext = require('../../src/opentracing/span_context')
const id = require('../../src/id')
const { USER_REJECT, AUTO_REJECT, AUTO_KEEP, USER_KEEP } = require('../../../../ext/priority')
const TraceState = require('../../src/opentracing/propagation/tracestate')

t.test('OTel Span Context', t => {
  t.test('should create new dd context if none given', t => {
    const context = new SpanContext()
    expect(context._ddContext).to.be.instanceOf(DDSpanContext)
    t.end()
  })

  t.test('should accept given dd context as-is', t => {
    const spanId = id()
    const ddContext = new DDSpanContext({
      traceId: spanId,
      spanId
    })
    const context = new SpanContext(ddContext)
    expect(context._ddContext).to.equal(ddContext)
    t.end()
  })

  t.test('should accept object to build new dd context', t => {
    const spanId = id()
    const context = new SpanContext({
      traceId: spanId,
      spanId
    })
    const ddContext = context._ddContext
    expect(ddContext).to.be.instanceOf(DDSpanContext)
    expect(ddContext._traceId).to.equal(spanId)
    expect(ddContext._spanId).to.equal(spanId)
    t.end()
  })

  t.test('should get trace id as hex', t => {
    const traceId = id()
    const context = new SpanContext({
      traceId
    })
    // normalize to 128 bit since that is what otel expects
    const normalizedTraceId = traceId.toString(16).padStart(32, '0')
    expect(context.traceId).to.equal(normalizedTraceId)
    t.end()
  })

  t.test('should get span id as hex', t => {
    const spanId = id()
    const context = new SpanContext({
      spanId
    })
    expect(context.spanId).to.equal(spanId.toString(16))
    t.end()
  })

  t.test('should map sampling priority to trace flags', t => {
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
      expect(context.traceFlags).to.equal(traceFlags)
    }
    t.end()
  })

  t.test('should get trace id as hex', t => {
    const tracestate = new TraceState()
    tracestate.forVendor('dd', vendor => {
      vendor.set('foo', 'bar')
    })

    const context = new SpanContext({
      tracestate
    })

    expect(context.traceState.serialize()).to.equal('dd=foo:bar')
    t.end()
  })
  t.end()
})
