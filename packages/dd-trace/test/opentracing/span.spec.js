'use strict'

require('../setup/tap')

const Config = require('../../src/config')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')

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
  let log

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

    log = {
      warn: sinon.stub(),
      error: sinon.stub()
    }

    Span = proxyquire('../src/opentracing/span', {
      perf_hooks: {
        performance: {
          now
        }
      },
      '../id': id,
      '../tagger': tagger,
      '../metrics': metrics,
      '../log': log
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  it('should have a default context', () => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._spanId).to.deep.equal('123')
    expect(span.context()._isRemote).to.deep.equal(false)
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
        tags: {},
        origin: 'synthetics'
      }
    }

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._parentId).to.deep.equal('456')
    expect(span.context()._baggageItems).to.deep.equal({ foo: 'bar' })
    expect(span.context()._trace).to.equal(parent._trace)
    expect(span.context()._isRemote).to.equal(false)
  })

  it('should generate a 128-bit trace ID when configured', () => {
    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      traceId128BitGenerationEnabled: true
    })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._trace.tags).to.have.property('_dd.p.tid')
    expect(span.context()._trace.tags['_dd.p.tid']).to.match(/^[a-f0-9]{8}0{8}$/)
  })

  it('should be published via dd-trace:span:start channel', () => {
    const onSpan = sinon.stub()
    startCh.subscribe(onSpan)

    const fields = {
      operationName: 'operation'
    }

    try {
      span = new Span(tracer, processor, prioritySampler, fields)

      expect(onSpan).to.have.been.calledOnce
      expect(onSpan.firstCall.args[0]).to.deep.equal({ span, fields })
    } finally {
      startCh.unsubscribe(onSpan)
    }
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
          foo: 'bar'
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

  // TODO are these tests trivial?
  describe('links', () => {
    it('should allow links to be added', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addLink(span2.context())
      expect(span).to.have.property('_links')
      expect(span._links).to.have.lengthOf(1)
    })

    it('sanitizes attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      const attributes = {
        foo: 'bar',
        baz: 'qux'
      }
      span.addLink(span2.context(), attributes)
      expect(span._links[0].attributes).to.deep.equal(attributes)
    })

    it('sanitizes nested attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      const attributes = {
        foo: true,
        bar: 'hi',
        baz: 1,
        qux: [1, 2, 3]
      }

      span.addLink(span2.context(), attributes)
      expect(span._links[0].attributes).to.deep.equal({
        foo: 'true',
        bar: 'hi',
        baz: '1',
        'qux.0': '1',
        'qux.1': '2',
        'qux.2': '3'
      })
    })

    it('sanitizes invalid attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const attributes = {
        foo: () => {},
        bar: Symbol('bar'),
        baz: 'valid'
      }

      span.addLink(span2.context(), attributes)
      expect(span._links[0].attributes).to.deep.equal({
        baz: 'valid'
      })
    })
  })

  describe('span pointers', () => {
    it('should add a span pointer with a zero context', () => {
      // Override id stub for this test to return '0' when called with '0'
      id.withArgs('0').returns('0')

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addSpanPointer('pointer_kind', 'd', 'abc123')
      expect(span._links).to.have.lengthOf(1)
      expect(span._links[0].context.toTraceId()).to.equal('0')
      expect(span._links[0].context.toSpanId()).to.equal('0')
      expect(span._links[0].attributes).to.deep.equal({
        'ptr.kind': 'pointer_kind',
        'ptr.dir': 'd',
        'ptr.hash': 'abc123',
        'link.kind': 'span-pointer'
      })
    })

    span.addSpanPointer('another_kind', 'd', '1234567')
    expect(span._links).to.have.lengthOf(2)
    expect(span._links[1].attributes).to.deep.equal({
      'ptr.kind': 'another_kind',
      'ptr.dir': 'd',
      'ptr.hash': '1234567',
      'link.kind': 'span-pointer'
    })
    expect(span._links[1].context.toTraceId()).to.equal('0')
    expect(span._links[1].context.toSpanId()).to.equal('0')
  })

  describe('events', () => {
    it('should add span events', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addEvent('Web page unresponsive',
        { 'error.code': '403', 'unknown values': [1] }, 1714536311886)
      span.addEvent('Web page loaded')
      span.addEvent('Button changed color', { colors: [112, 215, 70], 'response.time': 134.3, success: true })

      const events = span._events
      const expectedEvents = [
        {
          name: 'Web page unresponsive',
          startTime: 1714536311886,
          attributes: {
            'error.code': '403',
            'unknown values': [1]
          }
        },
        {
          name: 'Web page loaded',
          startTime: 1500000000000
        },
        {
          name: 'Button changed color',
          attributes: {
            colors: [112, 215, 70],
            'response.time': 134.3,
            success: true
          },
          startTime: 1500000000000
        }
      ]
      expect(events).to.deep.equal(expectedEvents)
    })
  })

  describe('recordException', () => {
    it('should record exception', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      try {
        throw new TypeError("foo")
      } catch(error) {
        span.recordException(error)
      }

      try {
        throw new Error("bar")
      } catch(error) {
        span.recordException(error)
      }

      const events = span._events
      expect(events).to.have.lengthOf(2)

      expect(events[0].name).to.equal('exception')
      expect(events[0].attributes).to.have.property('exception.type', 'TypeError')
      expect(events[0].attributes).to.have.property('exception.message', 'foo')

      expect(events[1].name).to.equal('exception')
      expect(events[1].attributes).to.have.property('exception.type', 'Error')
      expect(events[1].attributes).to.have.property('exception.message', 'bar')
    })

    it('should record exception when error is not an error object', async () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      await Promise.reject({ message: "something went wrong" }).catch(error => span.recordException(error));

      const events = span._events
      expect(events).to.have.lengthOf(1)

      expect(events[0].name).to.equal('exception')
      expect(Object.keys(events[0].attributes)).to.have.lengthOf(1)
      expect(events[0].attributes).to.have.property('exception.message', 'something went wrong')
    })

    it('should record exception with custom attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      try {
        throw new TypeError("foo")
      } catch(error) {
        span.recordException(error, {'foo': 'bar'})
      }

      const events = span._events
      expect(events).to.have.lengthOf(1)

      expect(events[0].name).to.equal('exception')
      expect(events[0].attributes).to.have.property('exception.type', 'TypeError')
      expect(events[0].attributes).to.have.property('exception.message', 'foo')
      expect(events[0].attributes).to.have.property('foo', 'bar')
    })

    it('should record exception with invalid attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      try {
        throw new TypeError("foo")
      } catch(error) {
        span.recordException(error,
          {'foo': 'bar',
           'invalid1': [1, false],
           'invalid2': [[1]],
           'invalid3': {"foo": "bar"},
           "invalid4": NaN,
           "invalid5": 9223372036854775808n,
          })
      }

      const events = span._events
      expect(events).to.have.lengthOf(1)

      expect(events[0].name).to.equal('exception')
      expect(Object.keys(events[0].attributes)).to.have.lengthOf(4)
      expect(events[0].attributes).to.have.property('exception.type', 'TypeError')
      expect(events[0].attributes).to.have.property('exception.message', 'foo')
      expect(events[0].attributes).to.have.property('foo', 'bar')

      // Check that warning logs were called for invalid attributes
      expect(log.warn).to.have.been.calledWith('Dropping span event attribute. Attribute invalid1 array values are not homogenous or valid: 1,false')
      expect(log.warn).to.have.been.calledWith('Dropping span event attribute. List values invalid2 must be string, number, or boolean: 1')
      expect(log.warn).to.have.been.calledWith('Dropping span event attribute. Attribute invalid3 must be (array of) string, number, or boolean: [object Object]')
      expect(log.warn).to.have.been.calledWith('Dropping span event attribute. Attribute invalid4 must be a finite number: NaN')
      expect(log.warn).to.have.been.calledWith('Dropping span event attribute. Attribute invalid5 must be (array of) string, number, or boolean: 9223372036854775808')
    })
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
    })
  })

  describe('getAllBaggageItems', () => {
    it('should get all baggage items', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      expect(span.getAllBaggageItems()).to.equal(JSON.stringify({}))

      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      expect(span.getAllBaggageItems()).to.equal(JSON.stringify({
        foo: 'bar',
        raccoon: 'cute'
      }))
    })
  })

  describe('removeBaggageItem', () => {
    it('should remove a baggage item', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      expect(span.getBaggageItem('foo')).to.equal('bar')
      span.removeBaggageItem('foo')
      expect(span.getBaggageItem('foo')).to.be.undefined
    })
  })

  describe('removeAllBaggageItems', () => {
    it('should remove all baggage items', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      span.removeAllBaggageItems()
      expect(span._spanContext._baggageItems).to.deep.equal({})
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

    it('should add _dd.integration', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(span._spanContext._tags).to.include({ '_dd.integration': 'opentracing' })
    })

    describe('tracePropagationBehaviorExtract and Baggage', () => {
      let parent

      beforeEach(() => {
        parent = {
          traceId: '123',
          spanId: '456',
          _baggageItems: {
            foo: 'bar'
          },
          _trace: {
            started: ['span'],
            finished: ['span']
          },
          _isRemote: true
        }
      })

      it('should not propagate baggage items when Trace_Propagation_Behavior_Extract is set to ignore', () => {
        tracer = {
          _config: {
            tracePropagationBehaviorExtract: 'ignore'
          }
        }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        expect(span._spanContext._baggageItems).to.deep.equal({})
      })

      it('should propagate baggage items when Trace_Propagation_Behavior_Extract is set to restart', () => {
        tracer = {
          _config: {
            tracePropagationBehaviorExtract: 'restart'
          }
        }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        expect(span._spanContext._baggageItems).to.deep.equal({ foo: 'bar' })
      })
    })
  })
})
