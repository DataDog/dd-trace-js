'use strict'

const Span = require('opentracing').Span

describe('NoopTracer', () => {
  let NoopTracer
  let tracer

  beforeEach(() => {
    NoopTracer = require('../src/noop/tracer')
    tracer = new NoopTracer()
  })

  describe('trace', () => {
    it('should return a noop span', done => {
      tracer.trace('test', {}, span => {
        expect(span).to.be.instanceof(Span)
        done()
      })
    })
  })

  describe('currentSpan', () => {
    it('should return null', () => {
      expect(tracer.currentSpan()).to.be.null
    })
  })

  describe('startSpan', () => {
    it('should return a span with a valid context', () => {
      const span = tracer.startSpan()

      expect(span.context().toTraceId).to.be.a('function')
      expect(span.context().toTraceId()).to.equal('')
      expect(span.context().toSpanId).to.be.a('function')
      expect(span.context().toSpanId()).to.equal('')
    })
  })
})
