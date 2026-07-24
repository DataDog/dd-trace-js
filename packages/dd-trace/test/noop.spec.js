'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

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
})

describe('NoopTracer lazy span', () => {
  let idSpy
  let LazyNoopTracer

  beforeEach(() => {
    const realId = require('../src/id')
    // Named function (not an arrow) so the spy has an own `.prototype` for proxyquire's key-copying.
    idSpy = sinon.spy(function (...args) { return realId(...args) })
    const NoopSpan = proxyquire('../src/noop/span', { '../id': idSpy })
    LazyNoopTracer = proxyquire('../src/noop/tracer', { './span': NoopSpan })
  })

  it('does not generate a span id when constructed', () => {
    // eslint-disable-next-line no-new
    new LazyNoopTracer()
    assert.ok(idSpy.notCalled, 'id() must not be called at construction (global-scope RNG)')
  })

  it('generates the span lazily on first use and reuses it', () => {
    const tracer = new LazyNoopTracer()
    const first = tracer.startSpan('test')
    assert.ok(first, 'startSpan returns a span')
    assert.ok(idSpy.called, 'id() is called on first span use')
    const callsAfterFirst = idSpy.callCount
    const second = tracer.startSpan('test')
    assert.strictEqual(second, first, 'same shared noop span is reused')
    assert.strictEqual(idSpy.callCount, callsAfterFirst, 'no new id() on reuse')
  })
})
