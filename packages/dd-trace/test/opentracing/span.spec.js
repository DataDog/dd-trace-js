'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { DD_MAJOR } = require('../../../../version')
const getConfig = require('../../src/config')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')

const startCh = channel('dd-trace:span:start')
const tagsUpdateCh = channel('dd-trace:span:tags:update')

describe('Span', () => {
  let Span
  let span
  let tracer
  let processor
  let prioritySampler
  let now
  let id
  let tagger

  beforeEach(() => {
    sinon.stub(Date, 'now').returns(1500000000000)

    now = sinon.stub().returns(0)

    id = sinon.stub()
    id.onFirstCall().returns('123')
    id.onSecondCall().returns('456')

    tracer = { _config: getConfig() }

    processor = {
      process: sinon.stub(),
    }

    prioritySampler = {
      sample: sinon.stub(),
    }

    tagger = {
      add: sinon.spy(),
    }

    Span = proxyquire('../../src/opentracing/span', {
      perf_hooks: {
        performance: {
          now,
        },
      },
      '../id': id,
      '../tagger': tagger,
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  it('should have a default context', () => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    assert.deepStrictEqual(span.context()._traceId, '123')
    assert.deepStrictEqual(span.context()._spanId, '123')
    assert.deepStrictEqual(span.context()._isRemote, false)
  })

  it('should add itself to the context trace started spans', () => {
    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

    assert.deepStrictEqual(span.context()._trace.started, [span])
  })

  it('should calculate its start time and duration relative to the trace start', () => {
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(300)
    now.onThirdCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    span.finish()

    assert.strictEqual(Math.round(span._startTime), 1500000000200)
    assert.strictEqual(Math.round(span._duration), 400)
  })

  it('should use the parent span to find the trace start', () => {
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(100)

    const parent = new Span(tracer, processor, prioritySampler, {
      operationName: 'parent',
    })

    now.resetHistory()
    now.onFirstCall().returns(300)
    now.onSecondCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      parent: parent.context(),
    })
    span.finish()

    assert.strictEqual(Math.round(span._startTime), 1500000000200)
    assert.strictEqual(Math.round(span._duration), 400)
  })

  it('should generate new timing when the parent was extracted', () => {
    const propagator = new TextMapPropagator(getConfig())
    const parent = propagator.extract({
      'x-datadog-trace-id': '1234',
      'x-datadog-parent-id': '5678',
    })

    now.onFirstCall().returns(100)
    now.onSecondCall().returns(300)
    now.onThirdCall().returns(700)

    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      parent,
    })
    span.finish()

    assert.strictEqual(Math.round(span._startTime), 1500000000200)
    assert.strictEqual(Math.round(span._duration), 400)
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
        origin: 'synthetics',
      },
    }

    span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })

    assert.deepStrictEqual(span.context()._traceId, '123')
    assert.deepStrictEqual(span.context()._parentId, '456')
    assert.deepStrictEqual(span.context()._baggageItems, { foo: 'bar' })
    assert.strictEqual(span.context()._trace, parent._trace)
    assert.strictEqual(span.context()._isRemote, false)
  })

  it('should generate a 128-bit trace ID when configured', () => {
    span = new Span(tracer, processor, prioritySampler, {
      operationName: 'operation',
      traceId128BitGenerationEnabled: true,
    })

    assert.deepStrictEqual(span.context()._traceId, '123')
    const traceTags = span.context()._trace.tags
    assert.ok(Object.hasOwn(traceTags, '_dd.p.tid'), `Available keys: ${inspect(Object.keys(traceTags))}`)
    assert.match(traceTags['_dd.p.tid'], /^[a-f0-9]{8}0{8}$/)
  })

  it('should be published via dd-trace:span:start channel', () => {
    const onSpan = sinon.stub()
    startCh.subscribe(onSpan)

    const fields = {
      operationName: 'operation',
    }

    try {
      span = new Span(tracer, processor, prioritySampler, fields)

      sinon.assert.calledOnce(onSpan)
      assert.deepStrictEqual(onSpan.firstCall.args[0], { span, fields })
    } finally {
      startCh.unsubscribe(onSpan)
    }
  })

  describe('tracer', () => {
    it('should return its parent tracer', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      assert.strictEqual(span.tracer(), tracer)
    })
  })

  describe('setOperationName', () => {
    it('should set the operation name', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'foo' })
      span.setOperationName('bar')

      assert.strictEqual(span.context()._name, 'bar')
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
          finished: ['span'],
        },
      }

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
      span.setBaggageItem('foo', 'bar')

      assert.ok('foo' in span.context()._baggageItems)
      assert.strictEqual(span.context()._baggageItems.foo, 'bar')
      assert.ok(
        !('foo' in parent._baggageItems) || parent._baggageItems.foo !== 'bar',
        `Got parent._baggageItems: ${inspect(parent._baggageItems)}`
      )
    })

    it('should pass baggage items to future causal spans', () => {
      const parent = {
        traceId: '123',
        spanId: '456',
        _baggageItems: {
          foo: 'bar',
        },
        _trace: {
          started: ['span'],
          finished: ['span'],
        },
      }

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })

      assert.ok('foo' in span.context()._baggageItems)
      assert.strictEqual(span.context()._baggageItems.foo, 'bar')
    })
  })

  // TODO are these tests trivial?
  describe('links', () => {
    it('should allow links to be added', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addLink({ context: span2.context() })
      assert.ok(Object.hasOwn(span, '_links'), `Available keys: ${inspect(Object.keys(span))}`)
      assert.strictEqual(span._links.length, 1)
    })

    it('sanitizes attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      const attributes = {
        foo: 'bar',
        baz: 'qux',
      }
      span.addLink({ context: span2.context(), attributes })
      assert.deepStrictEqual(span._links[0].attributes, attributes)
    })

    it('sanitizes nested attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      const attributes = {
        foo: true,
        bar: 'hi',
        baz: 1,
        qux: [1, 2, 3],
      }

      span.addLink({ context: span2.context(), attributes })
      assert.deepStrictEqual(span._links[0].attributes, {
        foo: 'true',
        bar: 'hi',
        baz: '1',
        'qux.0': '1',
        'qux.1': '2',
        'qux.2': '3',
      })
    })

    it('sanitizes invalid attributes', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const attributes = {
        foo: () => {},
        bar: Symbol('bar'),
        baz: 'valid',
      }

      span.addLink({ context: span2.context(), attributes })
      assert.deepStrictEqual(span._links[0].attributes, {
        baz: 'valid',
      })
    })

    const legacyAddLinkTest = DD_MAJOR < 6 ? it : it.skip
    legacyAddLinkTest('still accepts the deprecated (spanContext, attributes) form on v5', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      const span2 = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addLink(span2.context(), { foo: 'bar' })
      assert.strictEqual(span._links.length, 1)
      assert.deepStrictEqual(span._links[0].attributes, { foo: 'bar' })
    })

    it('seeds links from constructor fields.links and sanitizes their attributes', () => {
      const seed = new Span(tracer, processor, prioritySampler, { operationName: 'seed' })
      span = new Span(tracer, processor, prioritySampler, {
        operationName: 'with-links',
        links: [
          { context: seed.context(), attributes: { color: 'blue', extras: [1, 2] } },
          { context: seed.context(), attributes: undefined },
        ],
      })

      assert.strictEqual(span._links.length, 2)
      assert.deepStrictEqual(span._links[0].attributes, {
        color: 'blue',
        'extras.0': '1',
        'extras.1': '2',
      })
      assert.strictEqual(span._links[1].attributes, undefined)
    })
  })

  describe('span pointers', () => {
    it('should add a span pointer with a zero context', () => {
      // Override id stub for this test to return '0' when called with '0'
      id.withArgs('0').returns('0')

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })

      span.addSpanPointer('pointer_kind', 'd', 'abc123')
      assert.strictEqual(span._links.length, 1)
      assert.strictEqual(span._links[0].context.toTraceId(), '0')
      assert.strictEqual(span._links[0].context.toSpanId(), '0')
      assert.deepStrictEqual(span._links[0].attributes, {
        'ptr.kind': 'pointer_kind',
        'ptr.dir': 'd',
        'ptr.hash': 'abc123',
        'link.kind': 'span-pointer',
      })

      span.addSpanPointer('another_kind', 'd', '1234567')
      assert.strictEqual(span._links.length, 2)
      assert.deepStrictEqual(span._links[1].attributes, {
        'ptr.kind': 'another_kind',
        'ptr.dir': 'd',
        'ptr.hash': '1234567',
        'link.kind': 'span-pointer',
      })
      assert.strictEqual(span._links[1].context.toTraceId(), '0')
      assert.strictEqual(span._links[1].context.toSpanId(), '0')
    })
  })

  describe('events', () => {
    it('should add span events', () => {
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
            'unknown values': [1],
          },
        },
        {
          name: 'Web page loaded',
          startTime: 1500000000000,
        },
        {
          name: 'Button changed color',
          attributes: {
            colors: [112, 215, 70],
            'response.time': 134.3,
            success: true,
          },
          startTime: 1500000000000,
        },
      ]
      assert.deepStrictEqual(events, expectedEvents)
    })
  })

  describe('empty event and link attributes (end to end)', () => {
    // addEvent / addLink sanitize empty (and all-dropped) attribute sets to
    // `undefined` at the source, so format() and every 0.4 encoder path omit
    // the slot instead of emitting `"attributes":{}`. The encoders trust that
    // contract and skip the per-entry emptiness probe, so this guards the wire.
    const msgpack = require('@msgpack/msgpack')
    const format = require('../../src/span_format')
    // Real id (not the suite's string stub) so span-link contexts serialize.
    const RealSpan = require('../../src/opentracing/span')

    function buildSpan () {
      const span = new RealSpan(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.addEvent('empty', {})
      span.addEvent('all dropped', { nested: { not: 'allowed' } })
      span.addEvent('kept', { rating: 9 })
      span.addLink({ context: span.context(), attributes: {} })
      span.addLink({ context: span.context(), attributes: { nested: { not: 'allowed' } } })
      span.addLink({ context: span.context(), attributes: { color: 'blue' } })
      span.finish()
      return span
    }

    it('sanitizes empty and all-dropped attributes to undefined on the span', () => {
      const span = buildSpan()

      assert.strictEqual(span._events[0].attributes, undefined)
      assert.strictEqual(span._events[1].attributes, undefined)
      assert.deepStrictEqual(span._events[2].attributes, { rating: 9 })

      assert.strictEqual(span._links[0].attributes, undefined)
      assert.strictEqual(span._links[1].attributes, undefined)
      assert.deepStrictEqual(span._links[2].attributes, { color: 'blue' })
    })

    for (const nativeSpanEvents of [false, true]) {
      it(`omits empty attributes through format() + 0.4 encode (native span events: ${nativeSpanEvents})`, () => {
        const { AgentEncoder } = proxyquire('../../src/encode/0.4', {
          '../config': () => ({ DD_TRACE_NATIVE_SPAN_EVENTS: nativeSpanEvents }),
        })
        const encoder = new AgentEncoder({ flush () {} })

        encoder.encode([format(buildSpan())])
        const encoded = msgpack.decode(encoder.makePayload(), { useBigInt64: true })[0][0]

        const links = JSON.parse(encoded.meta['_dd.span_links'])
        assert.ok(!('attributes' in links[0]), 'empty link attributes must be omitted')
        assert.ok(!('attributes' in links[1]), 'all-dropped link attributes must be omitted')
        assert.deepStrictEqual(links[2].attributes, { color: 'blue' })

        const events = nativeSpanEvents ? encoded.span_events : JSON.parse(encoded.meta.events)
        assert.ok(!('attributes' in events[0]), 'empty event attributes must be omitted')
        assert.ok(!('attributes' in events[1]), 'all-dropped event attributes must be omitted')
        assert.ok('attributes' in events[2], 'kept event attributes must be present')
      })
    }
  })

  describe('getBaggageItem', () => {
    it('should get a baggage item', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'

      assert.strictEqual(span.getBaggageItem('foo'), 'bar')
    })
  })

  describe('getAllBaggageItems', () => {
    it('should get all baggage items', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      assert.strictEqual(span.getAllBaggageItems(), JSON.stringify({}))

      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      assert.strictEqual(span.getAllBaggageItems(), JSON.stringify({
        foo: 'bar',
        raccoon: 'cute',
      }))
    })
  })

  describe('removeBaggageItem', () => {
    it('should remove a baggage item', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      assert.strictEqual(span.getBaggageItem('foo'), 'bar')
      span.removeBaggageItem('foo')
      assert.strictEqual(span.getBaggageItem('foo'), undefined)
    })
  })

  describe('removeAllBaggageItems', () => {
    it('should remove all baggage items', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span._spanContext._baggageItems.foo = 'bar'
      span._spanContext._baggageItems.raccoon = 'cute'
      span.removeAllBaggageItems()
      assert.deepStrictEqual(span._spanContext._baggageItems, {})
    })
  })

  describe('setTag', () => {
    it('should set a tag', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.setTag('foo', 'bar')

      assert.strictEqual(span.context().getTag('foo'), 'bar')
      sinon.assert.notCalled(tagger.add)
      sinon.assert.notCalled(prioritySampler.sample)
    })

    it('should sample based on manual sampling tags', () => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.setTag(MANUAL_KEEP, true)

      assert.strictEqual(span.context().getTag(MANUAL_KEEP), true)
      sinon.assert.calledWith(prioritySampler.sample, span, false)
    })

    it('should be published via dd-trace:span:tags:update channel', () => {
      const onTagsUpdate = sinon.stub()
      tagsUpdateCh.subscribe(onTagsUpdate)

      try {
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
        span.setTag('foo', 'bar')

        sinon.assert.calledOnceWithExactly(onTagsUpdate, span, 'dd-trace:span:tags:update')
      } finally {
        tagsUpdateCh.unsubscribe(onTagsUpdate)
      }
    })
  })

  describe('addTags', () => {
    beforeEach(() => {
      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
    })

    it('should add tags from an object without going through tagger.add', () => {
      span.addTags({ foo: 'bar', baz: 'qux' })

      assert.strictEqual(span.context().getTag('foo'), 'bar')
      assert.strictEqual(span.context().getTag('baz'), 'qux')
      sinon.assert.notCalled(tagger.add)
      sinon.assert.notCalled(prioritySampler.sample)
    })

    it('should ignore unsupported argument types', () => {
      const tagsBefore = { ...span.context().getTags() }
      span.addTags(42)
      span.addTags(null)
      span.addTags(undefined)

      assert.deepStrictEqual(span.context().getTags(), tagsBefore)
      sinon.assert.notCalled(tagger.add)
      sinon.assert.notCalled(prioritySampler.sample)
    })

    const legacyAddTagsShape = DD_MAJOR < 6 ? it : it.skip
    legacyAddTagsShape('still accepts string and array inputs via tagger on v5', () => {
      span.addTags('foo:bar')
      span.addTags([{ baz: 'qux' }])

      sinon.assert.calledWith(tagger.add, span.context().getTags(), 'foo:bar')
      sinon.assert.calledWith(tagger.add, span.context().getTags(), [{ baz: 'qux' }])
    })

    const v6AddTagsShape = DD_MAJOR >= 6 ? it : it.skip
    v6AddTagsShape('drops string and array inputs on v6', () => {
      const tagsBefore = { ...span.context().getTags() }
      span.addTags('foo:bar')
      span.addTags([{ baz: 'qux' }])

      assert.deepStrictEqual(span.context().getTags(), tagsBefore)
      sinon.assert.notCalled(tagger.add)
      sinon.assert.notCalled(prioritySampler.sample)
    })

    it('should sample based on manual sampling tags', () => {
      span.addTags({ [MANUAL_KEEP]: true })

      assert.strictEqual(span.context().getTag(MANUAL_KEEP), true)
      sinon.assert.calledWith(prioritySampler.sample, span, false)
    })

    it('should be published via dd-trace:span:tags:update channel', () => {
      const onTagsUpdate = sinon.stub()
      tagsUpdateCh.subscribe(onTagsUpdate)

      try {
        span.addTags({ foo: 'bar' })

        sinon.assert.calledOnceWithExactly(onTagsUpdate, span, 'dd-trace:span:tags:update')
      } finally {
        tagsUpdateCh.unsubscribe(onTagsUpdate)
      }
    })
  })

  describe('finish', () => {
    it('should add itself to the context trace finished spans', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      assert.deepStrictEqual(span.context()._trace.finished, [span])
    })

    it('should record the span', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      sinon.assert.calledWith(processor.process, span)
    })

    it('should not record the span if already finished', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()
      span.finish()

      sinon.assert.calledOnce(processor.process)
    })

    it('should add _dd.integration', () => {
      processor.process.returns(Promise.resolve())

      span = new Span(tracer, processor, prioritySampler, { operationName: 'operation' })
      span.finish()

      assertObjectContains(span._spanContext.getTags(), { '_dd.integration': 'opentracing' })
    })

    describe('tracePropagationBehaviorExtract and Baggage', () => {
      let parent

      beforeEach(() => {
        parent = {
          traceId: '123',
          spanId: '456',
          _baggageItems: {
            foo: 'bar',
          },
          _trace: {
            started: ['span'],
            finished: ['span'],
          },
          _isRemote: true,
        }
      })

      it('should not propagate baggage items when Trace_Propagation_Behavior_Extract is set to ignore', () => {
        tracer = { _config: { ...getConfig(), DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT: 'ignore' } }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        assert.deepStrictEqual(span._spanContext._baggageItems, {})
      })

      it('should propagate baggage items when Trace_Propagation_Behavior_Extract is set to restart', () => {
        tracer = { _config: { ...getConfig(), DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT: 'restart' } }
        span = new Span(tracer, processor, prioritySampler, { operationName: 'operation', parent })
        assert.deepStrictEqual(span._spanContext._baggageItems, { foo: 'bar' })
      })
    })
  })
})
