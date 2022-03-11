'use strict'

const { expect } = require('chai')
const { id } = require('../../../datadog-tracer/src/id')

describe('SpanContext', () => {
  let SpanContext
  let span

  beforeEach(() => {
    SpanContext = require('../../src/opentracing/span_context')

    span = {
      spanId: id('456'),
      parentId: id('789'),
      service: 'test',
      name: 'test',
      duration: 1000,
      meta: { str: 'test' },
      metrics: { num: 1 },
      baggage: { foo: 'bar' },
      trace: {
        traceId: id('123'),
        spans: [],
        started: 0,
        finished: 0,
        samplingPriority: 2,
        meta: { foo: 'bar' }
      }
    }
  })

  it('should instantiate with the given properties', () => {
    const span1 = { duration: 1234 }
    const span2 = { duration: 0 }

    span.trace.spans = [span1, span2]
    span.started = 2
    span.finished = 1

    const spanContext = new SpanContext(span)

    expect(spanContext._traceId).to.equal(span.trace.traceId)
    expect(spanContext._spanId).to.equal(span.spanId)
    expect(spanContext._parentId).to.equal(span.parentId)
    expect(spanContext._name).to.equal(span.name)
    expect(spanContext._tags).to.include({ str: 'test', num: 1 })
    expect(spanContext._sampling).to.have.property('priority', 2)
    expect(spanContext._baggageItems).to.include({ foo: 'bar' })
    expect(spanContext._trace).to.deep.include({
      started: [span1, span2],
      finished: [span1],
      tags: { foo: 'bar' }
    })
  })

  describe('toTraceId()', () => {
    it('should return the trace ID as string', () => {
      const spanContext = new SpanContext(span)

      expect(spanContext.toTraceId()).to.equal('123')
    })
  })

  describe('toSpanId()', () => {
    it('should return the span ID as string', () => {
      const spanContext = new SpanContext(span)

      expect(spanContext.toSpanId()).to.equal('456')
    })
  })
})
