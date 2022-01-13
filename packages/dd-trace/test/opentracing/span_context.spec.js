'use strict'

const id = require('../../src/id')

describe('SpanContext', () => {
  let SpanContext

  beforeEach(() => {
    SpanContext = require('../../src/opentracing/span_context')
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
      }
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
      }
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
      }
    })
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
