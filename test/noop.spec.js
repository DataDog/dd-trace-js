'use strict'

const Span = require('opentracing').Span

describe('NoopTracer', () => {
  let tracer

  beforeEach(() => {
    tracer = require('../src/noop/tracer')
  })

  describe('trace', () => {
    it('should provide a span and done function', () => {
      tracer.trace('test', {}, (span, done) => {
        expect(span).to.be.instanceof(Span)
        expect(done).to.be.a('function')
        expect(done).to.not.throw()
      })
    })

    it('should return the return value of the function', () => {
      const result = tracer.trace('test', {}, () => 'test')

      expect(result).to.equal('test')
    })
  })

  describe('wrap', () => {
    it('should return the function', () => {
      const fn = () => {}

      expect(tracer.wrap('test', {}, fn)).to.equal(fn)
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
      expect(span.context().toTraceId()).to.equal('0')
      expect(span.context().toSpanId).to.be.a('function')
      expect(span.context().toSpanId()).to.equal('0')
    })
  })
})
