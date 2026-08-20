'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const id = require('../../dd-trace/src/id')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const TraceState = require('../../dd-trace/src/opentracing/propagation/tracestate')
const { createWebSocketSpanContext, hasDistributedTracingContext } = require('../src/util')

describe('WebSocket context utilities', () => {
  it('detaches link context through its public propagation projection', () => {
    const context = new SpanContext({
      traceId: id('0123456789abcdef', 16),
      spanId: id('fedcba9876543210', 16),
      sampling: { priority: 1 },
      traceparent: { version: '00' },
      tracestate: TraceState.fromString('dd=s:1;o:synthetics;t.dm:-4'),
      trace: {
        started: [],
        finished: [],
        tags: { '_dd.p.tid': '1234567890abcdef' },
      },
    })

    const detachedContext = createWebSocketSpanContext(context)

    assert.notStrictEqual(detachedContext, context)
    assert.strictEqual(detachedContext.toTraceId(true), context.toTraceId(true))
    assert.strictEqual(detachedContext.toSpanId(true), context.toSpanId(true))
    assert.strictEqual(detachedContext.toTraceparent(), context.toTraceparent())
    assert.strictEqual(detachedContext.toTracestate(), context.toTracestate())
  })

  it('uses socket-owned header state for distributed tracing eligibility', () => {
    const context = {}

    assert.strictEqual(hasDistributedTracingContext(context, { hasTraceHeaders: true }), true)
    assert.strictEqual(hasDistributedTracingContext(context, { hasTraceHeaders: false }), false)
    assert.strictEqual(hasDistributedTracingContext(undefined, { hasTraceHeaders: true }), false)
  })
})
