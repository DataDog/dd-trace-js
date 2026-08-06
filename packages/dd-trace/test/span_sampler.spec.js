'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')
const id = require('../src/id')
const {
  SPAN_SAMPLING_MECHANISM,
  SPAN_SAMPLING_RULE_RATE,
  SPAN_SAMPLING_MAX_PER_SECOND,
  SAMPLING_MECHANISM_SPAN,
} = require('../src/constants')

describe('span sampler', () => {
  const spies = {}
  let SpanSampler
  let SamplingRule

  beforeEach(() => {
    if (!SamplingRule) {
      SamplingRule = require('../src/sampling_rule')
      spies.match = sinon.spy(SamplingRule.prototype, 'match')
      spies.sample = sinon.spy(SamplingRule.prototype, 'sample')
      spies.sampleRate = sinon.spy(SamplingRule.prototype, 'sampleRate', ['get'])
      spies.maxPerSecond = sinon.spy(SamplingRule.prototype, 'maxPerSecond', ['get'])
    }

    SpanSampler = proxyquire('../src/span_sampler', {
      './sampling_rule': SamplingRule,
    })
  })

  it('should not sample anything when trace is kept', done => {
    const sampler = new SpanSampler({})

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {
        priority: 2,
      },
      _trace: {
        started: [],
      },
      _name: 'operation',
      _tags: {},
      getTag (key) { return this._tags[key] },
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })

    try {
      const ingested = sampler.sample(spanContext)
      assert.strictEqual(ingested, undefined)
      done()
    } catch (err) { done(err) }
  })

  it('adds _spanSampling when sampled successfully', () => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5,
        },
      ],
    })

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started: [],
      },
      _name: 'operation',
      _tags: {},
      getTag (key) { return this._tags[key] },
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })

    sampler.sample(spanContext)

    sinon.assert.called(spies.match)
    sinon.assert.called(spies.sample)
    sinon.assert.called(spies.sampleRate.get)
    sinon.assert.called(spies.maxPerSecond.get)

    assert.deepStrictEqual(spanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 5,
    })
  })

  it('should stop at first rule match', () => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'does-not-match',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 3,
        },
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5,
        },
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 10,
        },
      ],
    })

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started: [],
      },
      _name: 'operation',
      _tags: {},
      getTag (key) { return this._tags[key] },
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })

    sampler.sample(spanContext)

    sinon.assert.called(spies.match)
    sinon.assert.called(spies.sample)
    sinon.assert.called(spies.sampleRate.get)
    sinon.assert.called(spies.maxPerSecond.get)

    assert.deepStrictEqual(spanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 5,
    })
  })

  it('should sample multiple spans with one rule', () => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: '*operation',
          sampleRate: 1.0,
          maxPerSecond: 5,
        },
      ],
    })

    const started = []
    const firstSpanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started,
      },
      _name: 'operation',
      _tags: {},
      getTag (key) { return this._tags[key] },
    }
    const secondSpanContext = {
      ...firstSpanContext,
      _spanId: id('1234567812345679'),
      _name: 'second operation',
    }

    started.push({
      context: sinon.stub().returns(firstSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })
    started.push({
      context: sinon.stub().returns(secondSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })

    sampler.sample(firstSpanContext)

    sinon.assert.called(spies.match)
    sinon.assert.called(spies.sample)
    sinon.assert.called(spies.sampleRate.get)
    sinon.assert.called(spies.maxPerSecond.get)

    assert.deepStrictEqual(firstSpanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 5,
    })
    assert.deepStrictEqual(secondSpanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 5,
    })
  })

  it('should sample mutiple spans with multiple rules', () => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5,
        },
        {
          service: 'test',
          name: 'second*',
          sampleRate: 1.0,
          maxPerSecond: 3,
        },
      ],
    })

    const started = []
    const firstSpanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started,
      },
      _name: 'operation',
      _tags: {},
      getTag (key) { return this._tags[key] },
    }
    const secondSpanContext = {
      ...firstSpanContext,
      _spanId: id('1234567812345679'),
      _name: 'second operation',
    }

    started.push({
      context: sinon.stub().returns(firstSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })
    started.push({
      context: sinon.stub().returns(secondSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
      }),
      _name: 'operation',
    })

    sampler.sample(firstSpanContext)

    sinon.assert.called(spies.match)
    sinon.assert.called(spies.sample)
    sinon.assert.called(spies.sampleRate.get)
    sinon.assert.called(spies.maxPerSecond.get)

    assert.deepStrictEqual(firstSpanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 5,
    })
    assert.deepStrictEqual(secondSpanContext._spanSampling, {
      sampleRate: 1.0,
      maxPerSecond: 3,
    })
  })

  describe('native span ingestion tags', () => {
    const defaultRule = {
      service: 'test',
      name: 'operation',
      sampleRate: 1.0,
      maxPerSecond: 10,
    }

    function createNativeSpans () {
      return { queueBatchMetrics: sinon.stub() }
    }

    function createSampler (nativeSpans, rule = defaultRule) {
      return new SpanSampler({ spanSamplingRules: [rule], nativeSpans })
    }

    function createSpan (started = [], options = {}) {
      const {
        idValue = '1234567812345678',
        includeNativeSpanId = true,
        name = 'operation',
        nativeSpanId = 42,
        service = 'test',
      } = options
      const context = {
        _spanId: id(idValue),
        _sampling: {},
        _trace: { started },
        _name: name,
        _tags: {},
        getTag (key) { return this._tags[key] },
      }
      if (includeNativeSpanId) {
        context._nativeSpanId = new Uint8Array([nativeSpanId, 0, 0, 0, 0, 0, 0, 0])
      }
      const tracer = { _service: service }
      started.push({
        context: () => context,
        tracer: () => tracer,
        _name: name,
      })
      return context
    }

    function expectedMetrics (maxPerSecond = 10) {
      const metrics = [
        [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
        [SPAN_SAMPLING_RULE_RATE, 1.0],
      ]
      if (Number.isFinite(maxPerSecond)) {
        metrics.push([SPAN_SAMPLING_MAX_PER_SECOND, maxPerSecond])
      }
      return metrics
    }

    it('queues single-span ingestion metrics when rule matches', () => {
      const nativeSpans = createNativeSpans()
      const spanContext = createSpan()

      createSampler(nativeSpans).sample(spanContext)

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]),
        expectedMetrics(),
      ])
      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10,
      })
    })

    it('does not queue metrics or set _spanSampling when rule matches but sample returns false', () => {
      const nativeSpans = createNativeSpans()
      const sampler = new SpanSampler({ nativeSpans })
      sampler._rules = [{
        match: sinon.stub().returns(true),
        sample: sinon.stub().returns(false),
        sampleRate: 0,
        maxPerSecond: 0,
      }]
      const spanContext = createSpan()

      sampler.sample(spanContext)

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
      assert.strictEqual(spanContext._spanSampling, undefined)
    })

    it('omits max_per_second when Infinity', () => {
      const nativeSpans = createNativeSpans()
      const spanContext = createSpan([], { nativeSpanId: 1 })

      createSampler(nativeSpans, { ...defaultRule, maxPerSecond: Infinity }).sample(spanContext)

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
        expectedMetrics(Infinity),
      ])
    })

    it('skips native ops when _nativeSpanId is undefined', () => {
      const nativeSpans = createNativeSpans()
      const spanContext = createSpan([], { includeNativeSpanId: false })

      createSampler(nativeSpans, { ...defaultRule, maxPerSecond: 5 }).sample(spanContext)

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5,
      })
    })

    it('skips native ops when nativeSpans is not provided', () => {
      const spanContext = createSpan([], { nativeSpanId: 7 })

      createSampler(undefined, { ...defaultRule, maxPerSecond: 5 }).sample(spanContext)

      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5,
      })
    })

    it('queues metrics for multiple matching spans with different span ids', () => {
      const nativeSpans = createNativeSpans()
      const started = []
      const firstSpanContext = createSpan(started)
      const secondSpanContext = createSpan(started, {
        idValue: '1234567812345679',
        nativeSpanId: 99,
      })

      createSampler(nativeSpans).sample(firstSpanContext)

      sinon.assert.callCount(nativeSpans.queueBatchMetrics, 2)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]),
        expectedMetrics(),
      ])
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[1], [
        new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0]),
        expectedMetrics(),
      ])
      assert.deepStrictEqual(secondSpanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10,
      })
    })

    it('only queues metrics for spans that match the sampling rule', () => {
      const nativeSpans = createNativeSpans()
      const started = []
      const matchingContext = createSpan(started)
      const nonMatchingContext = createSpan(started, {
        idValue: '1234567812345679',
        name: 'other_operation',
        nativeSpanId: 99,
      })

      createSampler(nativeSpans).sample(matchingContext)

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]),
        expectedMetrics(),
      ])
      assert.strictEqual(nonMatchingContext._spanSampling, undefined)
    })

    it('memoizes metrics array across spans matching the same rule', () => {
      const nativeSpans = createNativeSpans()
      const started = []
      const firstSpanContext = createSpan(started)
      createSpan(started, {
        idValue: '1234567812345679',
        nativeSpanId: 99,
      })

      createSampler(nativeSpans).sample(firstSpanContext)

      sinon.assert.callCount(nativeSpans.queueBatchMetrics, 2)
      assert.strictEqual(
        nativeSpans.queueBatchMetrics.firstCall.args[1],
        nativeSpans.queueBatchMetrics.secondCall.args[1],
        'metrics array reference should be the same (memoized)'
      )
    })

    it('skips native ops when no rule matches any span', () => {
      const nativeSpans = createNativeSpans()
      const started = []
      const spanContext = createSpan(started)
      createSpan(started, {
        idValue: '1234567812345679',
        name: 'other_operation',
        nativeSpanId: 99,
      })

      createSampler(nativeSpans, {
        ...defaultRule,
        service: 'nomatch',
        name: 'nomatch',
        maxPerSecond: 5,
      }).sample(spanContext)

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
    })

    it('queues native ops for an all-zero span id', () => {
      const nativeSpans = createNativeSpans()
      const spanContext = createSpan([], { nativeSpanId: 0 })

      createSampler(nativeSpans).sample(spanContext)

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(
        nativeSpans.queueBatchMetrics.args[0][0],
        new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])
      )
    })
  })
})
