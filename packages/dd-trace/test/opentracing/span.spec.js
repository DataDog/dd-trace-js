'use strict'

const t = require('tap')
require('../setup/core')

const Config = require('../../src/config')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')

t.test('Span', t => {
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

  t.beforeEach(() => {
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
      perf_hooks: {
        performance: {
          now
        }
      },
      '../id': id,
      '../tagger': tagger,
      '../metrics': metrics
    })
  })

  t.afterEach(() => {
    Date.now.restore()
  })

  t.test('should have a default context', t => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._spanId).to.deep.equal('123')
    expect(span.context()._isRemote).to.deep.equal(false)
    t.end()
  })

  t.test('should add itself to the context trace started spans', t => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    expect(span.context()._trace.started).to.deep.equal([span])
    t.end()
  })

  t.test('should calculate its start time and duration relative to the trace start', t => {
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(300)
    now.onThirdCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    span.finish()

    expect(Math.round(span._startTime)).to.equal(1500000000200)
    expect(Math.round(span._duration)).to.equal(400)
    t.end()
  })

  t.test('should use the parent span to find the trace start', t => {
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
    t.end()
  })

  t.test('should generate new timing when the parent was extracted', t => {
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
    t.end()
  })

  t.test('should use a parent context', t => {
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
    t.end()
  })

  t.test('should generate a 128-bit trace ID when configured', t => {
    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      traceId128BitGenerationEnabled: true
    })

    expect(span.context()._traceId).to.deep.equal('123')
    expect(span.context()._trace.tags).to.have.property('_dd.p.tid')
    expect(span.context()._trace.tags['_dd.p.tid']).to.match(/^[a-f0-9]{8}0{8}$/)
    t.end()
  })

  t.test('should be published via dd-trace:span:start channel', t => {
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
    t.end()
  })

  t.test('tracer', t => {
    t.test('should return its parent tracer', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      expect(span.tracer()).to.equal(tracer)
      t.end()
    })
    t.end()
  })

  t.test('setOperationName', t => {
    t.test('should set the operation name', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'foo' })
      span.setOperationName('bar')

      expect(span.context()._name).to.equal('bar')
      t.end()
    })
    t.end()
  })

  t.test('setBaggageItem', t => {
    t.test('should set a baggage item on the trace', t => {
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
      t.end()
    })

    t.test('should pass baggage items to future causal spans', t => {
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
      t.end()
    })
    t.end()
  })

  // TODO are these tests trivial?
  t.test('links', t => {
    t.test('should allow links to be added', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addLink(span2.context())
      expect(span).to.have.property('_links')
      expect(span._links).to.have.lengthOf(1)
      t.end()
    })

    t.test('sanitizes attributes', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      const attributes = {
        foo: 'bar',
        baz: 'qux'
      }
      span.addLink(span2.context(), attributes)
      expect(span._links[0].attributes).to.deep.equal(attributes)
      t.end()
    })

    t.test('sanitizes nested attributes', t => {
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
      t.end()
    })

    t.test('sanitizes invalid attributes', t => {
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
      t.end()
    })
    t.end()
  })

  t.test('span pointers', t => {
    t.test('should add a span pointer with a zero context', t => {
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
      t.end()
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
    t.end()
  })

  t.test('events', t => {
    t.test('should add span events', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addEvent('Web page unresponsive',
        { 'error.code': '403', 'unknown values': [1, ['h', 'a', [false]]] }, 1714536311886)
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
      t.end()
    })
    t.end()
  })

  t.test('getBaggageItem', t => {
    t.test('should get a baggage item', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      expect(span.getBaggageItem('foo')).to.equal('bar')
      t.end()
    })
    t.end()
  })

  t.test('getAllBaggageItems', t => {
    t.test('should get all baggage items', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      expect(span.getAllBaggageItems()).to.equal(JSON.stringify({}))

      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      expect(span.getAllBaggageItems()).to.equal(JSON.stringify({
        foo: 'bar',
        raccoon: 'cute'
      }))
      t.end()
    })
    t.end()
  })

  t.test('removeBaggageItem', t => {
    t.test('should remove a baggage item', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      expect(span.getBaggageItem('foo')).to.equal('bar')
      span.removeBaggageItem('foo')
      expect(span.getBaggageItem('foo')).to.be.undefined
      t.end()
    })
    t.end()
  })

  t.test('removeAllBaggageItems', t => {
    t.test('should remove all baggage items', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      span.removeAllBaggageItems()
      expect(span._spanContext._baggageItems).to.deep.equal({})
      t.end()
    })
    t.end()
  })

  t.test('setTag', t => {
    t.test('should set a tag', t => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, { foo: 'bar' })
      t.end()
    })
    t.end()
  })

  t.test('addTags', t => {
    t.beforeEach(() => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    })

    t.test('should add tags', t => {
      const tags = { foo: 'bar' }

      span.addTags(tags)

      expect(tagger.add).to.have.been.calledWith(span.context()._tags, tags)
      t.end()
    })

    t.test('should sample based on the tags', t => {
      const tags = { foo: 'bar' }

      span.addTags(tags)

      expect(prioritySampler.sample).to.have.been.calledWith(span, false)
      t.end()
    })
    t.end()
  })

  t.test('finish', t => {
    t.test('should add itself to the context trace finished spans', t => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(span.context()._trace.finished).to.deep.equal([span])
      t.end()
    })

    t.test('should record the span', t => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      expect(processor.process).to.have.been.calledWith(span)
      t.end()
    })

    t.test('should not record the span if already finished', t => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      expect(processor.process).to.have.been.calledOnce
      t.end()
    })

    t.test('tracePropagationBehaviorExtract and Baggage', t => {
      let parent

      t.beforeEach(() => {
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

      t.test('should not propagate baggage items when Trace_Propagation_Behavior_Extract is set to ignore', t => {
        tracer = {
          _config: {
            tracePropagationBehaviorExtract: 'ignore'
          }
        }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        expect(span._spanContext._baggageItems).to.deep.equal({})
        t.end()
      })

      t.test('should propagate baggage items when Trace_Propagation_Behavior_Extract is set to restart', t => {
        tracer = {
          _config: {
            tracePropagationBehaviorExtract: 'restart'
          }
        }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        expect(span._spanContext._baggageItems).to.deep.equal({ foo: 'bar' })
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
