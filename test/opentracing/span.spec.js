'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const constants = require('../../src/constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

describe('Span', () => {
  let Span
  let span
  let tracer
  let recorder
  let prioritySampler
  let sampler
  let platform
  let handle

  beforeEach(() => {
    handle = { finish: sinon.spy() }
    platform = {
      id: sinon.stub(),
      metrics: sinon.stub().returns({
        track: sinon.stub().returns(handle)
      })
    }
    platform.id.onFirstCall().returns(new Uint64BE(123, 123))
    platform.id.onSecondCall().returns(new Uint64BE(456, 456))

    tracer = {}

    sampler = {
      rate: sinon.stub().returns(1)
    }

    recorder = {
      record: sinon.stub()
    }

    prioritySampler = {
      sample: sinon.stub()
    }

    Span = proxyquire('../src/opentracing/span', {
      '../platform': platform
    })
  })

  it('should have a default context', () => {
    span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })

    expect(span.context()._traceId).to.deep.equal(new Uint64BE(123, 123))
    expect(span.context()._spanId).to.deep.equal(new Uint64BE(123, 123))
  })

  it('should add itself to the context trace started spans', () => {
    span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })

    expect(span.context()._trace.started).to.deep.equal([span])
  })

  it('should use a parent context', () => {
    const parent = {
      _traceId: new Uint64BE(123, 123),
      _spanId: new Uint64BE(456, 456),
      _baggageItems: { foo: 'bar' },
      _trace: {
        started: ['span'],
        finished: [],
        origin: 'synthetics'
      }
    }

    span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation', parent })

    expect(span.context()._traceId).to.deep.equal(new Uint64BE(123, 123))
    expect(span.context()._parentId).to.deep.equal(new Uint64BE(456, 456))
    expect(span.context()._baggageItems).to.deep.equal({ foo: 'bar' })
    expect(span.context()._trace.started).to.deep.equal(['span', span])
    expect(span.context()._trace.origin).to.equal('synthetics')
  })

  it('should start a new trace if the parent trace is finished', () => {
    const parent = {
      _traceId: new Uint64BE(123, 123),
      _spanId: new Uint64BE(456, 456),
      _baggageItems: { foo: 'bar' },
      _trace: {
        started: ['span'],
        finished: ['span'],
        origin: 'synthetics'
      }
    }

    span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation', parent })

    expect(span.context()._trace.started).to.deep.equal([span])
    expect(span.context()._trace.origin).to.equal('synthetics')
  })

  it('should set the sample rate metric from the sampler', () => {
    expect(span.context()._metrics).to.have.property(SAMPLE_RATE_METRIC_KEY, 1)
  })

  it('should keep track of its memory lifecycle', () => {
    span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })

    expect(platform.metrics().track).to.have.been.calledWith(span)

    span.finish()

    expect(handle.finish).to.have.been.called
  })

  describe('tracer', () => {
    it('should return its parent tracer', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })

      expect(span.tracer()).to.equal(tracer)
    })
  })

  describe('setOperationName', () => {
    it('should set the operation name', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'foo' })
      span.setOperationName('bar')

      expect(span.context()._name).to.equal('bar')
    })
  })

  describe('setBaggageItem', () => {
    it('should set a baggage item on the trace', () => {
      const parent = {
        traceId: new Uint64BE(123, 123),
        spanId: new Uint64BE(456, 456),
        _baggageItems: {},
        _trace: {
          started: ['span'],
          finished: ['span']
        }
      }

      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation', parent })
      span.setBaggageItem('foo', 'bar')

      expect(span.context()._baggageItems).to.have.property('foo', 'bar')
      expect(parent._baggageItems).to.have.property('foo', 'bar')
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
    })
  })

  describe('setTag', () => {
    it('should set a tag', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      expect(span.context()._tags).to.have.property('foo', 'bar')
    })
  })

  describe('addTags', () => {
    it('should add tags', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.addTags({ foo: 'bar' })

      expect(span.context()._tags).to.have.property('foo', 'bar')
    })

    it('should store the original values', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.addTags({ foo: 123 })

      expect(span.context()._tags).to.have.property('foo', 123)
    })

    it('should handle errors', () => {
      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })

      expect(() => span.addTags()).not.to.throw()
    })
  })

  describe('finish', () => {
    it('should add itself to the context trace finished spans', () => {
      recorder.record.returns(Promise.resolve())

      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(span.context()._trace.finished).to.deep.equal([span])
    })

    it('should record the span', () => {
      recorder.record.returns(Promise.resolve())

      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(recorder.record).to.have.been.calledWith(span)
    })

    it('should not record the span if already finished', () => {
      recorder.record.returns(Promise.resolve())

      span = new Span(tracer, recorder, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      expect(recorder.record).to.have.been.calledOnce
    })
  })
})
