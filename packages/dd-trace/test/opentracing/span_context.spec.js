'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha

require('../setup/core')

const id = require('../../src/id')

describe('SpanContext', () => {
  let SpanContext
  let TraceState

  beforeEach(() => {
    SpanContext = require('../../src/opentracing/span_context')
    TraceState = require('../../src/opentracing/propagation/tracestate')
  })

  it('should instantiate with the given properties', () => {
    const noop = {}
    const props = {
      traceId: '123',
      spanId: '456',
      parentId: '789',
      isRemote: false,
      name: 'test',
      isFinished: true,
      tags: { testTag: 'testValue' },
      metrics: {},
      sampling: { priority: 2 },
      baggageItems: { foo: 'bar' },
      noop,
      trace: {
        started: ['span1', 'span2'],
        finished: ['span1'],
        tags: { foo: 'bar' }
      },
      traceparent: '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01',
      tracestate: TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
    }
    const spanContext = new SpanContext(props)

    // Check individual properties since _tags is now private
    assert.strictEqual(spanContext._traceId, '123')
    assert.strictEqual(spanContext._spanId, '456')
    assert.strictEqual(spanContext._parentId, '789')
    assert.strictEqual(spanContext._isRemote, false)
    assert.strictEqual(spanContext._name, 'test')
    assert.strictEqual(spanContext._isFinished, true)
    assert.deepStrictEqual(spanContext.getTags(), { testTag: 'testValue' })
    assert.deepStrictEqual(spanContext._sampling, { priority: 2 })
    assert.strictEqual(spanContext._spanSampling, undefined)
    assert.deepStrictEqual(spanContext._links, [])
    assert.deepStrictEqual(spanContext._baggageItems, { foo: 'bar' })
    assert.strictEqual(spanContext._noop, noop)
    assert.deepStrictEqual(spanContext._trace, {
      started: ['span1', 'span2'],
      finished: ['span1'],
      tags: { foo: 'bar' }
    })
    assert.strictEqual(spanContext._traceparent, '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01')
    assert.deepStrictEqual(spanContext._tracestate, TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar'))
    assert.strictEqual(spanContext._otelSpanContext, undefined)
  })

  it('should have the correct default values', () => {
    const spanContext = new SpanContext({
      traceId: '123',
      spanId: '456'
    })

    // Check individual properties since _tags is now private
    assert.strictEqual(spanContext._traceId, '123')
    assert.strictEqual(spanContext._spanId, '456')
    assert.strictEqual(spanContext._parentId, null)
    assert.strictEqual(spanContext._isRemote, true)
    assert.strictEqual(spanContext._name, undefined)
    assert.strictEqual(spanContext._isFinished, false)
    assert.deepStrictEqual(spanContext.getTags(), {})
    assert.deepStrictEqual(spanContext._sampling, {})
    assert.strictEqual(spanContext._spanSampling, undefined)
    assert.deepStrictEqual(spanContext._links, [])
    assert.deepStrictEqual(spanContext._baggageItems, {})
    assert.strictEqual(spanContext._noop, null)
    assert.deepStrictEqual(spanContext._trace, {
      started: [],
      finished: [],
      tags: {}
    })
    assert.strictEqual(spanContext._traceparent, undefined)
    assert.strictEqual(spanContext._tracestate, undefined)
    assert.strictEqual(spanContext._otelSpanContext, undefined)
  })

  it('should share sampling object between contexts', () => {
    const first = new SpanContext({
      sampling: { priority: 1 }
    })
    const second = new SpanContext({
      sampling: first._sampling
    })
    second._sampling.priority = 2

    assert.strictEqual(first._sampling.priority, 2)
  })

  describe('toTraceId()', () => {
    it('should return the trace ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      assert.strictEqual(spanContext.toTraceId(), '123')
    })
  })

  describe('toSpanId()', () => {
    it('should return the span ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      assert.strictEqual(spanContext.toSpanId(), '456')
    })
  })

  describe('toTraceparent()', () => {
    it('should return the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16)
      })

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000000000000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the tag', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16)
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000007890000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('00000000000007890000000000000123', 16),
        spanId: id('456', 16)
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000007890000000000000123-0000000000000456-00')
    })
  })
})
