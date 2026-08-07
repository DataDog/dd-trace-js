'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const Span = require('../src/noop/span')

describe('NoopTracer', () => {
  let NoopTracer
  let tracer

  beforeEach(() => {
    NoopTracer = require('../src/noop/tracer')
    tracer = new NoopTracer()
  })

  describe('trace', () => {
    it('should provide a span and done function', () => {
      tracer.trace('test', {}, (span, done) => {
        assert.ok(span instanceof Span)
        assert.strictEqual(typeof done, 'function')
        done()
      })
    })

    it('should return the return value of the function', () => {
      const result = tracer.trace('test', {}, () => 'test')

      assert.strictEqual(result, 'test')
    })
  })

  describe('wrap', () => {
    it('should return the function', () => {
      const fn = () => {}

      assert.strictEqual(tracer.wrap('test', {}, fn), fn)
    })
  })

  describe('startSpan', () => {
    it('should return a span with a valid context', () => {
      const span = tracer.startSpan()

      assert.strictEqual(typeof span.context().toTraceId, 'function')
      assert.match(span.context().toTraceId(), /^\d+$/)
      assert.strictEqual(typeof span.context().toSpanId, 'function')
      assert.match(span.context().toSpanId(), /^\d+$/)
    })
  })

  describe('flush', () => {
    it('should call the done callback synchronously', () => {
      const done = sinon.spy()

      tracer.flush(done)

      sinon.assert.calledOnce(done)
    })

    it('should not throw when called without a callback', () => {
      tracer.flush()
    })
  })
})
