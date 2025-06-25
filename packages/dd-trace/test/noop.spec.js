'use strict'

const t = require('tap')
require('./setup/core')

const Span = require('../src/noop/span')

t.test('NoopTracer', t => {
  let NoopTracer
  let tracer

  t.beforeEach(() => {
    NoopTracer = require('../src/noop/tracer')
    tracer = new NoopTracer()
  })

  t.test('trace', t => {
    t.test('should provide a span and t function', t => {
      tracer.trace('test', {}, (span, done) => {
        expect(span).to.be.instanceof(Span)
        expect(done).to.be.a('function')
        expect(done).to.not.throw()
      })
      t.end()
    })

    t.test('should return the return value of the function', t => {
      const result = tracer.trace('test', {}, () => 'test')

      expect(result).to.equal('test')
      t.end()
    })
    t.end()
  })

  t.test('wrap', t => {
    t.test('should return the function', t => {
      const fn = () => {}

      expect(tracer.wrap('test', {}, fn)).to.equal(fn)
      t.end()
    })
    t.end()
  })

  t.test('startSpan', t => {
    t.test('should return a span with a valid context', t => {
      const span = tracer.startSpan()

      expect(span.context().toTraceId).to.be.a('function')
      expect(span.context().toTraceId()).to.match(/^\d+$/)
      expect(span.context().toSpanId).to.be.a('function')
      expect(span.context().toSpanId()).to.match(/^\d+$/)
      t.end()
    })
    t.end()
  })
  t.end()
})
