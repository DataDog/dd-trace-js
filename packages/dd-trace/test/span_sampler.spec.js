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
    it('queues single-span ingestion metrics when rule matches', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10,
          },
        ],
        nativeSpans,
      })

      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
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

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        42,
        [
          [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
          [SPAN_SAMPLING_RULE_RATE, 1.0],
          [SPAN_SAMPLING_MAX_PER_SECOND, 10],
        ],
      ])
      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 10,
      })
    })

    it('does not queue metrics or set _spanSampling when rule matches but sample returns false', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const rule = {
        match: sinon.stub().returns(true),
        sample: sinon.stub().returns(false),
        sampleRate: 0,
        maxPerSecond: 0,
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [],
        nativeSpans,
      })
      sampler._rules = [rule]

      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
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

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
      assert.strictEqual(spanContext._spanSampling, undefined)
    })

    it('omits max_per_second when Infinity', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: Infinity,
          },
        ],
        nativeSpans,
      })

      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 1,
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

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        1,
        [
          [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
          [SPAN_SAMPLING_RULE_RATE, 1.0],
        ],
      ])
    })

    it('skips native ops when slotIndex is undefined', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 5,
          },
        ],
        nativeSpans,
      })

      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        // No _slotIndex — noop span
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

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5,
      })
    })

    it('skips native ops when nativeSpans is not provided', () => {
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
        _slotIndex: 7,
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

      assert.deepStrictEqual(spanContext._spanSampling, {
        sampleRate: 1.0,
        maxPerSecond: 5,
      })
    })

    it('queues metrics for multiple matching spans with different slot indices', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10,
          },
        ],
        nativeSpans,
      })

      const started = []
      const firstSpanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }
      const secondSpanContext = {
        _spanId: id('1234567812345679'),
        _sampling: {},
        _slotIndex: 99,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
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

      sinon.assert.callCount(nativeSpans.queueBatchMetrics, 2)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        42,
        [
          [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
          [SPAN_SAMPLING_RULE_RATE, 1.0],
          [SPAN_SAMPLING_MAX_PER_SECOND, 10],
        ],
      ])
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[1], [
        99,
        [
          [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
          [SPAN_SAMPLING_RULE_RATE, 1.0],
          [SPAN_SAMPLING_MAX_PER_SECOND, 10],
        ],
      ])
    })

    it('only queues metrics for spans that match the sampling rule', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10,
          },
        ],
        nativeSpans,
      })

      const started = []
      const matchingContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }
      const nonMatchingContext = {
        _spanId: id('1234567812345679'),
        _sampling: {},
        _slotIndex: 99,
        _trace: { started },
        _name: 'other_operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }

      started.push({
        context: sinon.stub().returns(matchingContext),
        tracer: sinon.stub().returns({
          _service: 'test',
        }),
        _name: 'operation',
      })
      started.push({
        context: sinon.stub().returns(nonMatchingContext),
        tracer: sinon.stub().returns({
          _service: 'test',
        }),
        _name: 'other_operation',
      })

      sampler.sample(matchingContext)

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.deepStrictEqual(nativeSpans.queueBatchMetrics.args[0], [
        42,
        [
          [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
          [SPAN_SAMPLING_RULE_RATE, 1.0],
          [SPAN_SAMPLING_MAX_PER_SECOND, 10],
        ],
      ])
      assert.strictEqual(nonMatchingContext._spanSampling, undefined)
    })

    it('memoizes metrics array across spans matching the same rule', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10,
          },
        ],
        nativeSpans,
      })

      const started = []
      const firstSpanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }
      const secondSpanContext = {
        _spanId: id('1234567812345679'),
        _sampling: {},
        _slotIndex: 99,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
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

      sinon.assert.callCount(nativeSpans.queueBatchMetrics, 2)
      assert.strictEqual(
        nativeSpans.queueBatchMetrics.firstCall.args[1],
        nativeSpans.queueBatchMetrics.secondCall.args[1],
        'metrics array reference should be the same (memoized)'
      )
    })

    it('skips native ops when no rule matches any span', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'nomatch',
            name: 'nomatch',
            sampleRate: 1.0,
            maxPerSecond: 5,
          },
        ],
        nativeSpans,
      })

      const started = []
      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 42,
        _trace: { started },
        _name: 'operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }
      const otherSpanContext = {
        _spanId: id('1234567812345679'),
        _sampling: {},
        _slotIndex: 99,
        _trace: { started },
        _name: 'other_operation',
        _tags: {},
        getTag (key) { return this._tags[key] },
      }

      started.push({
        context: sinon.stub().returns(spanContext),
        tracer: sinon.stub().returns({
          _service: 'test',
        }),
        _name: 'operation',
      })
      started.push({
        context: sinon.stub().returns(otherSpanContext),
        tracer: sinon.stub().returns({
          _service: 'test',
        }),
        _name: 'other_operation',
      })

      sampler.sample(spanContext)

      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
    })

    it('queues native ops when slotIndex is 0 (falsy boundary)', () => {
      const nativeSpans = {
        queueBatchMetrics: sinon.stub(),
      }
      const sampler = new SpanSampler({
        spanSamplingRules: [
          {
            service: 'test',
            name: 'operation',
            sampleRate: 1.0,
            maxPerSecond: 10,
          },
        ],
        nativeSpans,
      })

      const spanContext = {
        _spanId: id('1234567812345678'),
        _sampling: {},
        _slotIndex: 0,
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

      sinon.assert.calledOnce(nativeSpans.queueBatchMetrics)
      assert.strictEqual(nativeSpans.queueBatchMetrics.args[0][0], 0)
    })
  })
})
