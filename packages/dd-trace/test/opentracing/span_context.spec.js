'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const id = require('../../src/id')
const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../ext/priority')

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
        tags: { foo: 'bar' },
      },
      traceparent: '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01',
      tracestate: TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar'),
    }
    const spanContext = new SpanContext(props)

    const expected = {
      _traceId: '123',
      _spanId: '456',
      _parentId: '789',
      _isRemote: false,
      _name: 'test',
      _isFinished: true,
      _tags: { testTag: 'testValue' },
      _sampling: { priority: 2 },
      _spanSampling: undefined,
      _links: [],
      _baggageItems: { foo: 'bar' },
      _noop: noop,
      _trace: {
        started: ['span1', 'span2'],
        finished: ['span1'],
        tags: { foo: 'bar' },
      },
      _traceparent: '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01',
      _tracestate: TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar'),
      _otelSpanContext: undefined,
      _otelActiveSpan: undefined,
    }
    Object.setPrototypeOf(expected, SpanContext.prototype)
    assert.deepStrictEqual(spanContext, expected)
  })

  it('should have the correct default values', () => {
    const spanContext = new SpanContext({
      traceId: '123',
      spanId: '456',
    })

    const expected = {
      _traceId: '123',
      _spanId: '456',
      _parentId: null,
      _isRemote: true,
      _name: undefined,
      _isFinished: false,
      _tags: {},
      _sampling: {},
      _spanSampling: undefined,
      _links: [],
      _baggageItems: {},
      _noop: null,
      _trace: {
        started: [],
        finished: [],
        tags: {},
      },
      _traceparent: undefined,
      _tracestate: undefined,
      _otelSpanContext: undefined,
      _otelActiveSpan: undefined,
    }
    Object.setPrototypeOf(expected, SpanContext.prototype)
    assert.deepStrictEqual(spanContext, expected)
  })

  it('should share sampling object between contexts', () => {
    const first = new SpanContext({
      sampling: { priority: 1 },
    })
    const second = new SpanContext({
      sampling: first._sampling,
    })
    second._sampling.priority = 2

    assert.strictEqual(first._sampling.priority, 2)
  })

  describe('toTraceId()', () => {
    it('should return the trace ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10),
      })

      assert.strictEqual(spanContext.toTraceId(), '123')
    })
  })

  describe('toSpanId()', () => {
    it('should return the span ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10),
      })

      assert.strictEqual(spanContext.toSpanId(), '456')
    })
  })

  describe('toTraceparent()', () => {
    it('should return the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16),
      })

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000000000000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the tag', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16),
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000007890000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('00000000000007890000000000000123', 16),
        spanId: id('456', 16),
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      assert.strictEqual(spanContext.toTraceparent(), '00-00000000000007890000000000000123-0000000000000456-00')
    })

    it('materializes the lazy sampling decision so the sampled flag is set before finish', () => {
      const spanContext = withRootSampler(AUTO_KEEP)

      assert.match(spanContext.toTraceparent(), /-01$/)
    })

    it('reflects a drop decision rather than defaulting the flag to keep', () => {
      const spanContext = withRootSampler(AUTO_REJECT)

      assert.match(spanContext.toTraceparent(), /-00$/)
      assert.strictEqual(spanContext._sampling.priority, AUTO_REJECT)
    })

    it('does not re-sample once a priority is already decided', () => {
      const spanContext = new SpanContext({ traceId: id('123', 16), spanId: id('456', 16) })
      spanContext._sampling.priority = USER_KEEP
      spanContext._trace.started.push({
        context: () => spanContext,
        _prioritySampler: { sample () { throw new Error('should not re-sample a decided trace') } },
      })

      assert.match(spanContext.toTraceparent(), /-01$/)
    })

    /**
     * Builds a context whose root span carries a priority sampler that records
     * the given decision, mirroring the lazy auto-sampling path.
     *
     * @param {import('../../src/priority_sampler').SamplingPriority} priority
     * @returns {SpanContext}
     */
    function withRootSampler (priority) {
      const spanContext = new SpanContext({ traceId: id('123', 16), spanId: id('456', 16) })
      spanContext._trace.started.push({
        context: () => spanContext,
        _prioritySampler: {
          sample (span) {
            span.context()._sampling.priority = priority
          },
        },
      })
      return spanContext
    }
  })

  describe('tag accessor API', () => {
    let spanContext

    beforeEach(() => {
      spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10),
      })
    })

    it('setTag stores the value; getTag returns it', () => {
      spanContext.setTag('foo', 'bar')
      assert.strictEqual(spanContext.getTag('foo'), 'bar')
    })

    it('setTag overwrites a previous value', () => {
      spanContext.setTag('foo', 'first')
      spanContext.setTag('foo', 'second')
      assert.strictEqual(spanContext.getTag('foo'), 'second')
    })

    it('getTag returns undefined for an unset key', () => {
      assert.strictEqual(spanContext.getTag('missing'), undefined)
    })

    it('hasTag distinguishes "set to undefined" from "unset"', () => {
      spanContext.setTag('explicit', undefined)
      assert.strictEqual(spanContext.hasTag('explicit'), true)
      assert.strictEqual(spanContext.hasTag('missing'), false)
      assert.strictEqual(spanContext.getTag('explicit'), undefined)
    })

    it('hasTag uses Object.hasOwn — Object.prototype keys do not register', () => {
      // The previous `key in this._tags` implementation matched
      // `'toString'` / `'hasOwnProperty'` etc. via the prototype chain.
      assert.strictEqual(spanContext.hasTag('toString'), false)
      assert.strictEqual(spanContext.hasTag('hasOwnProperty'), false)
    })

    it('deleteTag removes the key; hasTag reflects the removal', () => {
      spanContext.setTag('foo', 'bar')
      spanContext.deleteTag('foo')
      assert.strictEqual(spanContext.hasTag('foo'), false)
      assert.strictEqual(spanContext.getTag('foo'), undefined)
    })

    it('getTags returns the live internal tag map (callers may mutate)', () => {
      spanContext.setTag('a', '1')
      const tags = spanContext.getTags()
      assert.strictEqual(tags.a, '1')

      // Same reference on subsequent calls — `opentracing/span.js` relies on
      // `Object.assign(getTags(), fields.tags)` mutating the live map.
      assert.strictEqual(spanContext.getTags(), tags)

      tags.b = '2'
      assert.strictEqual(spanContext.getTag('b'), '2')
    })

    it('clearTags empties the map and continues to accept further writes', () => {
      spanContext.setTag('a', '1')
      spanContext.setTag('b', '2')
      spanContext.clearTags()
      assert.strictEqual(spanContext.hasTag('a'), false)
      assert.strictEqual(spanContext.hasTag('b'), false)
      // After clear, the backing map is a fresh Object.create(null) — empty,
      // but distinct from `{}` by prototype. Assert emptiness via key count.
      assert.strictEqual(Object.keys(spanContext.getTags()).length, 0)

      spanContext.setTag('c', '3')
      assert.strictEqual(spanContext.getTag('c'), '3')
    })
  })
})
