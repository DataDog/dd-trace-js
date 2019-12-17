'use strict'

const constants = require('../../src/constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

describe('Span', () => {
  let Span
  let span
  let tracer
  let processor
  let prioritySampler
  let sampler
  let platform
  let handle
  let id
  let tagger

  beforeEach(() => {
    handle = { finish: sinon.spy() }
    platform = {
      metrics: sinon.stub().returns({
        track: sinon.stub().returns(handle)
      })
    }

    id = sinon.stub()
    id.onFirstCall().returns('123')
    id.onSecondCall().returns('456')

    tracer = {}

    sampler = {
      rate: sinon.stub().returns(1)
    }

    processor = {
      process: sinon.stub()
    }

    prioritySampler = {
      sample: sinon.stub()
    }

    tagger = {
      add: sinon.spy()
    }

    Span = proxyquire('../src/opentracing/span', {
      '../platform': platform,
      '../id': id,
      '../tagger': tagger
    })
  })

  it('should have a default context', () => {
    span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._spanId).to.deep.equal('123')
  })

  it('should add itself to the context trace started spans', () => {
    span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })

    expect(span.context()._trace.started).to.deep.equal([span])
  })

  it('should use a parent context', () => {
    const parent = {
      _traceId: '123',
      _spanId: '456',
      _baggageItems: { foo: 'bar' },
      _trace: {
        started: ['span'],
        finished: [],
        origin: 'synthetics'
      }
    }

    span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation', parent })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._parentId).to.deep.equal('456')
    expect(span.context()._baggageItems).to.deep.equal({ foo: 'bar' })
    expect(span.context()._trace).to.equal(parent._trace)
  })

  it('should set the sample rate metric from the sampler', () => {
    expect(span.context()._tags).to.have.property(SAMPLE_RATE_METRIC_KEY, 1)
  })

  it('should keep track of its memory lifecycle', () => {
    span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })

    expect(platform.metrics().track).to.have.been.calledWith(span)

    span.finish()

    expect(handle.finish).to.have.been.called
  })

  describe('tracer', () => {
    it('should return its parent tracer', () => {
      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })

      expect(span.tracer()).to.equal(tracer)
    })
  })

  describe('setOperationName', () => {
    it('should set the operation name', () => {
      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'foo' })
      span.setOperationName('bar')

      expect(span.context()._name).to.equal('bar')
    })
  })

  describe('setBaggageItem', () => {
    it('should set a baggage item on the trace', () => {
      const parent = {
        traceId: '123',
        spanId: '456',
        _baggageItems: {},
        _trace: {
          started: ['span'],
          finished: ['span']
        }
      }

      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation', parent })
      span.setBaggageItem('foo', 'bar')

      expect(span.context()._baggageItems).to.have.property('foo', 'bar')
      expect(parent._baggageItems).to.have.property('foo', 'bar')
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
    })
  })

  describe('setTag', () => {
    it('should set a tag', () => {
      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, { foo: 'bar' })
    })
  })

  describe('addTags', () => {
    beforeEach(() => {
      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
    })

    it('should add tags', () => {
      const tags = { foo: 'bar' }

      span.addTags(tags)

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, tags)
    })
  })

  describe('finish', () => {
    it('should add itself to the context trace finished spans', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(span.context()._trace.finished).to.deep.equal([span])
    })

    it('should record the span', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(processor.process).to.have.been.calledWith(span)
    })

    it('should not record the span if already finished', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, sampler, prioritySampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      expect(processor.process).to.have.been.calledOnce
    })
  })
})
