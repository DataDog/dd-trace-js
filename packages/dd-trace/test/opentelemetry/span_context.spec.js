'use strict'

const { expect } = require('chai')
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
    expect(context._ddContext).to.be.instanceOf(DDSpanContext)
  })

  it('should accept given dd context as-is', () => {
    const spanId = id()
    const ddContext = new DDSpanContext({
      traceId: spanId,
      spanId
    })
    const context = new SpanContext(ddContext)
    expect(context._ddContext).to.equal(ddContext)
  })

  it('should accept object to build new dd context', () => {
    const spanId = id()
    const context = new SpanContext({
      traceId: spanId,
      spanId
    })
    const ddContext = context._ddContext
    expect(ddContext).to.be.instanceOf(DDSpanContext)
    expect(ddContext._traceId).to.equal(spanId)
    expect(ddContext._spanId).to.equal(spanId)
  })

  it('should get trace id as hex', () => {
    const traceId = id()
    const context = new SpanContext({
      traceId
    })
    // normalize to 128 bit since that is what otel expects
    const normalizedTraceId = traceId.toString(16).padStart(32, '0')
    expect(context.traceId).to.equal(normalizedTraceId)
  })

  it('should get span id as hex', () => {
    const spanId = id()
    const context = new SpanContext({
      spanId
    })
    expect(context.spanId).to.equal(spanId.toString(16))
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
      expect(context.traceFlags).to.equal(traceFlags)
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

    expect(context.traceState.serialize()).to.equal('dd=foo:bar')
  })
})
