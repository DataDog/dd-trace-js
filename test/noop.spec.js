'use strict'

const Span = require('opentracing').Span

describe('NoopTracer', () => {
  let NoopTracer
  let tracer

  beforeEach(() => {
    NoopTracer = require('../src/noop')
    tracer = new NoopTracer()
  })

  describe('use', () => {
    it('should return itself', () => {
      expect(tracer.use()).to.equal(tracer)
    })
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

  describe('bind', () => {
    it('should be a noop', () => {
      expect(tracer.bind).to.not.throw()
    })
  })

  describe('bindEmitter', () => {
    it('should be a noop', () => {
      expect(tracer.bindEmitter).to.not.throw()
    })
  })
})
