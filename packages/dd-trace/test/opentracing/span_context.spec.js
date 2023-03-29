'use strict'

require('../setup/tap')

const { expect } = require('chai')
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
      _name: 'test',
      _isFinished: true,
      _tags: {},
      _sampling: { priority: 2 },
      _baggageItems: { foo: 'bar' },
      _noop: noop,
      _trace: {
        started: ['span1', 'span2'],
        finished: ['span1'],
        tags: { foo: 'bar' }
      },
      _traceparent: '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01',
      _tracestate: TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
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
      _name: undefined,
      _isFinished: false,
      _tags: {},
      _sampling: {},
      _baggageItems: {},
      _noop: null,
      _trace: {
        started: [],
        finished: [],
        tags: {}
      },
      _traceparent: undefined,
      _tracestate: undefined
    })
  })

  it('should clone sampling object', () => {
    const first = new SpanContext({
      sampling: { priority: 1 }
    })
    const second = new SpanContext({
      sampling: first.sampling
    })
    second._sampling.priority = 2

    expect(first._sampling).to.have.property('priority', 1)
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
})
