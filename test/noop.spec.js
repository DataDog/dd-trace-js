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
})
