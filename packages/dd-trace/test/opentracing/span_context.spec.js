'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('../setup/tap')

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
      tags: {},
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

    expect(spanContext).to.deep.equal({
      _traceId: '123',
      _spanId: '456',
      _parentId: '789',
      _isRemote: false,
      _name: 'test',
      _isFinished: true,
      _tags: {},
      _sampling: { priority: 2 },
      _spanSampling: undefined,
      _links: [],
      _baggageItems: { foo: 'bar' },
      _noop: noop,
      _trace: {
        started: ['span1', 'span2'],
        finished: ['span1'],
        tags: { foo: 'bar' }
      },
      _traceparent: '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01',
      _tracestate: TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar'),
      _otelSpanContext: undefined
    })
  })

  it('should have the correct default values', () => {
    const spanContext = new SpanContext({
      traceId: '123',
      spanId: '456'
    })

    expect(spanContext).to.deep.equal({
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
        tags: {}
      },
      _traceparent: undefined,
      _tracestate: undefined,
      _otelSpanContext: undefined
    })
  })

  it('should share sampling object between contexts', () => {
    const first = new SpanContext({
      sampling: { priority: 1 }
    })
    const second = new SpanContext({
      sampling: first._sampling
    })
    second._sampling.priority = 2

    expect(first._sampling).to.have.property('priority', 2)
  })

  describe('toTraceId()', () => {
    it('should return the trace ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      expect(spanContext.toTraceId()).to.equal('123')
    })
  })

  describe('toSpanId()', () => {
    it('should return the span ID as string', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      expect(spanContext.toSpanId()).to.equal('456')
    })
  })

  describe('toTraceparent()', () => {
    it('should return the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16)
      })

      expect(spanContext.toTraceparent()).to.equal('00-00000000000000000000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the tag', () => {
      const spanContext = new SpanContext({
        traceId: id('123', 16),
        spanId: id('456', 16)
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      expect(spanContext.toTraceparent()).to.equal('00-00000000000007890000000000000123-0000000000000456-00')
    })

    it('should return the traceparent with 128-bit trace ID from the traceparent', () => {
      const spanContext = new SpanContext({
        traceId: id('00000000000007890000000000000123', 16),
        spanId: id('456', 16)
      })

      spanContext._trace.tags['_dd.p.tid'] = '0000000000000789'

      expect(spanContext.toTraceparent()).to.equal('00-00000000000007890000000000000123-0000000000000456-00')
    })
  })
})
