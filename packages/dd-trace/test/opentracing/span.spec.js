'use strict'

require('../setup/core')

const Config = require('../../src/config')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')

describe('Span', () => {
  let Span
  let span
  let tracer
  let processor
  let prioritySampler
  let now
  let metrics
  let handle
  let id
  let tagger

  beforeEach(() => {
    sinon.stub(Date, 'now').returns(1500000000000)

    handle = { finish: sinon.spy() }
    now = sinon.stub().returns(0)

    metrics = {
      track: sinon.stub().returns(handle)
    }

    id = sinon.stub()
    id.onFirstCall().returns('123')
    id.onSecondCall().returns('456')

    tracer = {}

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
      'perf_hooks': {
        performance: {
          now
        }
      },
      '../id': id,
      '../tagger': tagger,
      '../metrics': metrics
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  it('should have a default context', () => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._spanId).to.deep.equal('123')
  })

  it('should add itself to the context trace started spans', () => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    expect(span.context()._trace.started).to.deep.equal([span])
  })

  it('should calculate its start time and duration relative to the trace start', () => {
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(300)
    now.onThirdCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    span.finish()

    expect(Math.round(span._startTime)).to.equal(1500000000200)
    expect(Math.round(span._duration)).to.equal(400)
  })

  it('should use the parent span to find the trace start', () => {
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(100)

    const parent = new Span(tracer, processor, prioritySampler, {
      operationName: 'parent'
    })

    now.resetHistory()
    now.onFirstCall().returns(300)
    now.onSecondCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      parent: parent.context()
    })
    span.finish()

    expect(Math.round(span._startTime)).to.equal(1500000000200)
    expect(Math.round(span._duration)).to.equal(400)
  })

  it('should generate new timing when the parent was extracted', () => {
    const propagator = new TextMapPropagator(new Config())
    const parent = propagator.extract({
      'x-datadog-trace-id': '1234',
      'x-datadog-parent-id': '5678'
    })

    now.onFirstCall().returns(100)
    now.onSecondCall().returns(300)
    now.onThirdCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      parent
    })
    span.finish()

    expect(Math.round(span._startTime)).to.equal(1500000000200)
    expect(Math.round(span._duration)).to.equal(400)
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

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._parentId).to.deep.equal('456')
    expect(span.context()._baggageItems).to.deep.equal({ foo: 'bar' })
    expect(span.context()._trace).to.equal(parent._trace)
  })

  describe('tracer', () => {
    it('should return its parent tracer', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      expect(span.tracer()).to.equal(tracer)
    })
  })

  describe('setOperationName', () => {
    it('should set the operation name', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'foo' })
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

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
      span.setBaggageItem('foo', 'bar')

      expect(span.context()._baggageItems).to.have.property('foo', 'bar')
      expect(parent._baggageItems).to.not.have.property('foo', 'bar')
    })

    it('should pass baggage items to future causal spans', () => {
      const parent = {
        traceId: '123',
        spanId: '456',
        _baggageItems: {
          'foo': 'bar'
        },
        _trace: {
          started: ['span'],
          finished: ['span']
        }
      }

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })

      expect(span.context()._baggageItems).to.have.property('foo', 'bar')
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
    })
  })

  describe('setTag', () => {
    it('should set a tag', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, { foo: 'bar' })
    })
  })

  describe('addTags', () => {
    beforeEach(() => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    })

    it('should add tags', () => {
      const tags = { foo: 'bar' }

      span.addTags(tags)

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, tags)
    })

    it('should sample based on the tags', () => {
      const tags = { foo: 'bar' }

      span.addTags(tags)

      expect(prioritySampler.sample).to.have.been.calledWith(span, false)
    })
  })

  describe('finish', () => {
    it('should add itself to the context trace finished spans', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(span.context()._trace.finished).to.deep.equal([span])
    })

    it('should record the span', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(processor.process).to.have.been.calledWith(span)
    })

    it('should not record the span if already finished', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      expect(processor.process).to.have.been.calledOnce
    })
  })
})
