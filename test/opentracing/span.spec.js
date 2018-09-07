'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const constants = require('../../src/constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

describe('Span', () => {
  let Span
  let span
  let tracer
  let sampler
  let platform

  beforeEach(() => {
    platform = { id: sinon.stub() }
    platform.id.onFirstCall().returns(new Uint64BE(123, 123))
    platform.id.onSecondCall().returns(new Uint64BE(456, 456))

    tracer = {
      _record: sinon.stub()
    }

    sampler = {
      rate: sinon.stub().returns(1),
      isSampled: sinon.stub().returns(true)
    }

    Span = proxyquire('../src/opentracing/span', {
      '../platform': platform
    })
  })

  it('should have a default context', () => {
    span = new Span(tracer, sampler, { operationName: 'operation' })

    expect(span.context().traceId).to.deep.equal(new Uint64BE(123, 123))
    expect(span.context().spanId).to.deep.equal(new Uint64BE(123, 123))
  })

  it('should add itself to the context trace started spans', () => {
    span = new Span(tracer, sampler, { operationName: 'operation' })

    expect(span.context().trace.started).to.deep.equal([span])
  })

  it('should use a parent context', () => {
    const parent = {
      traceId: new Uint64BE(123, 123),
      spanId: new Uint64BE(456, 456),
      sampled: false,
      baggageItems: { foo: 'bar' },
      trace: {
        started: ['span'],
        finished: []
      }
    }

    span = new Span(tracer, sampler, { operationName: 'operation', parent })

    expect(span.context().traceId).to.deep.equal(new Uint64BE(123, 123))
    expect(span.context().parentId).to.deep.equal(new Uint64BE(456, 456))
    expect(span.context().baggageItems).to.deep.equal({ foo: 'bar' })
    expect(span.context().trace.started).to.deep.equal(['span', span])
  })

  it('should set the sample rate metric from the sampler', () => {
    expect(span._metrics).to.have.property(SAMPLE_RATE_METRIC_KEY, 1)
  })

  describe('tracer', () => {
    it('should return its parent tracer', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })

      expect(span.tracer()).to.equal(tracer)
    })
  })

  describe('setOperationName', () => {
    it('should set the operation name', () => {
      span = new Span(tracer, sampler, { operationName: 'foo' })
      span.setOperationName('bar')

      expect(span._operationName).to.equal('bar')
    })
  })

  describe('setBaggageItem', () => {
    it('should set a baggage item', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.setBaggageItem('foo', 'bar')

      expect(span.context().baggageItems).to.have.property('foo', 'bar')
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })
      span._spanContext.baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
    })
  })

  describe('setTag', () => {
    it('should set a tag', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      expect(span._tags).to.have.property('foo', 'bar')
    })
  })

  describe('addTags', () => {
    it('should add tags', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.addTags({ foo: 'bar' })

      expect(span._tags).to.have.property('foo', 'bar')
    })

    it('should ensure tags are strings', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.addTags({ foo: 123 })

      expect(span._tags).to.have.property('foo', '123')
    })

    it('should handle errors', () => {
      span = new Span(tracer, sampler, { operationName: 'operation' })

      expect(() => span.addTags()).not.to.throw()
    })
  })

  describe('finish', () => {
    it('should add itself to the context trace finished spans', () => {
      tracer._record.returns(Promise.resolve())

      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.finish()

      expect(span.context().trace.finished).to.deep.equal([span])
    })

    it('should record the span if sampled', () => {
      tracer._record.returns(Promise.resolve())

      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.finish()

      expect(tracer._record).to.have.been.calledWith(span)
    })

    it('should not record the span if not sampled', () => {
      tracer._record.returns(Promise.resolve())
      sampler.isSampled.returns(false)

      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.finish()

      expect(tracer._record).to.not.have.been.called
    })

    it('should not record the span if already finished', () => {
      tracer._record.returns(Promise.resolve())

      span = new Span(tracer, sampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      expect(tracer._record).to.have.been.calledOnce
    })
  })
})
