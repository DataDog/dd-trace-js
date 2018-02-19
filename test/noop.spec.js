'use strict'

const Span = require('opentracing').Span

describe('NoopTracer', () => {
  let NoopTracer
  let tracer

  beforeEach(() => {
    NoopTracer = require('../src/noop')
    tracer = new NoopTracer()
  })

  describe('trace', () => {
    it('should return a noop span', () => {
      const span = tracer.trace()

      expect(span).to.be.instanceof(Span)
    })
  })
})
