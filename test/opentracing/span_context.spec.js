'use strict'

describe('SpanContext', () => {
  let SpanContext

  beforeEach(() => {
    SpanContext = require('../../src/opentracing/span_context')
  })

  it('should instantiate with the given properties', () => {
    const props = {
      traceId: '123',
      spanId: '456',
      sampled: false,
      baggageItems: { foo: 'bar' }
    }
    const spanContext = new SpanContext(props)

    expect(spanContext).to.deep.equal(props)
  })

  it('should have the correct default values', () => {
    const expected = {
      traceId: '123',
      spanId: '456',
      sampled: true,
      baggageItems: {}
    }

    const spanContext = new SpanContext({
      traceId: expected.traceId,
      spanId: expected.spanId
    })

    expect(spanContext).to.deep.equal(expected)
  })
})
