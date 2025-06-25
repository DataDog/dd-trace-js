'use strict'

const t = require('tap')
require('./setup/core')

const id = require('../src/id')

t.test('span sampler', t => {
  const spies = {}
  let SpanSampler
  let SamplingRule

  t.beforeEach(() => {
    if (!SamplingRule) {
      SamplingRule = require('../src/sampling_rule')
      spies.match = sinon.spy(SamplingRule.prototype, 'match')
      spies.sample = sinon.spy(SamplingRule.prototype, 'sample')
      spies.sampleRate = sinon.spy(SamplingRule.prototype, 'sampleRate', ['get'])
      spies.maxPerSecond = sinon.spy(SamplingRule.prototype, 'maxPerSecond', ['get'])
    }

    SpanSampler = proxyquire('../src/span_sampler', {
      './sampling_rule': SamplingRule
    })
  })

  t.test('should not sample anything when trace is kept', t => {
    const sampler = new SpanSampler({})

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {
        priority: 2
      },
      _trace: {
        started: []
      },
      _name: 'operation',
      _tags: {}
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })

    try {
      const ingested = sampler.sample(spanContext)
      expect(ingested).to.be.undefined
      t.end()
    } catch (err) { t.error(err) }
  })

  t.test('adds _spanSampling when sampled successfully', t => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5
        }
      ]
    })

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started: []
      },
      _name: 'operation',
      _tags: {}
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })

    sampler.sample(spanContext)

    expect(spies.match).to.be.called
    expect(spies.sample).to.be.called
    expect(spies.sampleRate.get).to.be.called
    expect(spies.maxPerSecond.get).to.be.called

    expect(spanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 5
    })
    t.end()
  })

  t.test('should stop at first rule match', t => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'does-not-match',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 3
        },
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5
        },
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 10
        }
      ]
    })

    const spanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started: []
      },
      _name: 'operation',
      _tags: {}
    }
    spanContext._trace.started.push({
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })

    sampler.sample(spanContext)

    expect(spies.match).to.be.called
    expect(spies.sample).to.be.called
    expect(spies.sampleRate.get).to.be.called
    expect(spies.maxPerSecond.get).to.be.called

    expect(spanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 5
    })
    t.end()
  })

  t.test('should sample multiple spans with one rule', t => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: '*operation',
          sampleRate: 1.0,
          maxPerSecond: 5
        }
      ]
    })

    // Create two span contexts
    const started = []
    const firstSpanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started
      },
      _name: 'operation',
      _tags: {}
    }
    const secondSpanContext = {
      ...firstSpanContext,
      _spanId: id('1234567812345679'),
      _name: 'second operation'
    }

    // Add spans for both to the context
    started.push({
      context: sinon.stub().returns(firstSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })
    started.push({
      context: sinon.stub().returns(secondSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })

    sampler.sample(firstSpanContext)

    expect(spies.match).to.be.called
    expect(spies.sample).to.be.called
    expect(spies.sampleRate.get).to.be.called
    expect(spies.maxPerSecond.get).to.be.called

    expect(firstSpanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 5
    })
    expect(secondSpanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 5
    })
    t.end()
  })

  t.test('should sample mutiple spans with multiple rules', t => {
    const sampler = new SpanSampler({
      spanSamplingRules: [
        {
          service: 'test',
          name: 'operation',
          sampleRate: 1.0,
          maxPerSecond: 5
        },
        {
          service: 'test',
          name: 'second*',
          sampleRate: 1.0,
          maxPerSecond: 3
        }
      ]
    })

    // Create two span contexts
    const started = []
    const firstSpanContext = {
      _spanId: id('1234567812345678'),
      _sampling: {},
      _trace: {
        started
      },
      _name: 'operation',
      _tags: {}
    }
    const secondSpanContext = {
      ...firstSpanContext,
      _spanId: id('1234567812345679'),
      _name: 'second operation'
    }

    // Add spans for both to the context
    started.push({
      context: sinon.stub().returns(firstSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })
    started.push({
      context: sinon.stub().returns(secondSpanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _name: 'operation'
    })

    sampler.sample(firstSpanContext)

    expect(spies.match).to.be.called
    expect(spies.sample).to.be.called
    expect(spies.sampleRate.get).to.be.called
    expect(spies.maxPerSecond.get).to.be.called

    expect(firstSpanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 5
    })
    expect(secondSpanContext._spanSampling).to.eql({
      sampleRate: 1.0,
      maxPerSecond: 3
    })
    t.end()
  })
  t.end()
})
