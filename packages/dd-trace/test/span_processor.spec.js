'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('./setup/core')

describe('SpanProcessor', () => {
  let prioritySampler
  let processor
  let SpanProcessor
  let activeSpan
  let finishedSpan
  let trace
  let exporter
  let tracer
  let config
  let SpanSampler
  let sample
  let nativeSpans
  let fakeOpCode
  let extraServicesStub
  let registerExtraService

  before(() => {
    require('../src/process-tags').initialize()
  })

  beforeEach(() => {
    tracer = {}
    trace = {
      started: [],
      finished: [],
      tags: {},
    }

    let tags = {}
    const span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {},
        getTags: () => tags,
        getTag: (key) => tags[key],
        setTag: (key, value) => { tags[key] = value },
        hasTag: (key) => key in tags,
        clearTags: () => { tags = Object.create(null) },
      }),
    }

    activeSpan = { ...span }
    finishedSpan = { ...span, _duration: 100 }

    exporter = {
      export: sinon.stub(),
    }
    prioritySampler = {
      sample: sinon.stub(),
      _getPriorityFromTags: sinon.stub().returns(undefined),
      validate: sinon.stub().returns(false),
    }
    config = {
      flushMinSpans: 3,
      stats: {
        enabled: false,
      },
    }

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample,
    })

    fakeOpCode = {
      SetTraceMetricsAttr: 11,
      SetTraceMetaAttr: 10,
    }

    nativeSpans = {
      queueOp: sinon.stub(),
    }

    extraServicesStub = {
      registerExtraService: sinon.stub(),
      getExtraServices: sinon.stub().returns([]),
      clear: sinon.stub(),
    }
    registerExtraService = extraServicesStub.registerExtraService

    SpanProcessor = proxyquire('../src/span_processor', {
      './span_sampler': SpanSampler,
      './native': { OpCode: fakeOpCode },
      './service-naming/extra-services': extraServicesStub,
    })
    processor = new SpanProcessor(exporter, prioritySampler, config, nativeSpans)
  })

  it('should generate sampling priority', () => {
    // Provide a root span on the trace so _sampleNative has work to do, and
    // mark the trace as fully finished so process() advances past its early
    // return (`started.length === finished.length`).
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should generate sampling priority when sampling manually', () => {
    trace.started = [finishedSpan]
    processor.sample(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should erase the trace once finished', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    assert.ok('started' in trace)
    assert.deepStrictEqual(trace.started, [])
    assert.ok('finished' in trace)
    assert.deepStrictEqual(trace.finished, [])
    // _erase leaves per-span tag storage intact so callers that retain a
    // span ref after finish can still read tags.
    assert.deepStrictEqual(finishedSpan.context().getTags(), {})
  })

  it('should not flush a partial trace below the flushMinSpans threshold', () => {
    trace.started = [activeSpan, finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    sinon.assert.notCalled(exporter.export)
    assert.deepStrictEqual(trace.started, [activeSpan, finishedSpan])
    assert.deepStrictEqual(trace.finished, [finishedSpan])
  })

  it('should skip unrecorded traces', () => {
    trace.record = false
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(activeSpan)

    sinon.assert.notCalled(exporter.export)
  })

  it('should export a partial trace with span count above configured threshold', () => {
    // Spans are forwarded raw to the exporter; the WASM pipeline does the
    // serialization on the native side.
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan]
    processor.process(finishedSpan)

    sinon.assert.calledWith(exporter.export, [finishedSpan, finishedSpan, finishedSpan])

    assert.ok('started' in trace)
    assert.deepStrictEqual(trace.started, [activeSpan])
    assert.ok('finished' in trace)
    assert.deepStrictEqual(trace.finished, [])
  })

  it('should configure span sampler correctly', () => {
    const config = {
      stats: { enabled: false },
      sampler: {
        sampleRate: 0,
        spanSamplingRules: [
          {
            service: 'foo',
            name: 'bar',
            sampleRate: 123,
            maxPerSecond: 456,
          },
        ],
      },
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config, nativeSpans)
    processor.process(finishedSpan)

    sinon.assert.calledWith(SpanSampler, sinon.match({ nativeSpans }))
  })

  it('should erase the trace and stop execution when tracing=false', () => {
    const config = {
      tracing: false,
      stats: {
        enabled: false,
      },
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config, nativeSpans)
    trace.started = [activeSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    assert.ok('started' in trace)
    assert.deepStrictEqual(trace.started, [])
    assert.ok('finished' in trace)
    assert.deepStrictEqual(trace.finished, [])
    assert.deepStrictEqual(finishedSpan.context().getTags(), {})
    sinon.assert.notCalled(exporter.export)
  })

  describe('extra services registration', () => {
    beforeEach(() => {
      registerExtraService.resetHistory()
    })

    it('should register extra service when span has service.name tag', () => {
      const spanWithService = {
        ...finishedSpan,
        _duration: 100,
      }
      spanWithService.context().setTag('service.name', 'my-service')

      trace.started = [spanWithService]
      trace.finished = [spanWithService]
      processor.process(spanWithService)

      sinon.assert.calledOnceWithExactly(registerExtraService, 'my-service')
    })

    it('should not register extra service when span has no service.name tag', () => {
      trace.started = [finishedSpan]
      trace.finished = [finishedSpan]
      processor.process(finishedSpan)

      sinon.assert.notCalled(registerExtraService)
    })

    it('should not register extra services below the flushMinSpans threshold', () => {
      const spanA = { ...finishedSpan, _duration: 100 }
      const spanB = { ...finishedSpan, _duration: 100 }
      const spanC = { ...finishedSpan, _duration: 100 }

      trace.started = [spanA, spanB, spanC]
      trace.finished = [spanA]
      processor.process(spanA)

      sinon.assert.notCalled(registerExtraService)
    })

    it('should register extra services for all finished spans in the trace during flush', () => {
      let tagsA = {}
      let tagsB = {}
      const spanA = {
        tracer: sinon.stub().returns(tracer),
        context: sinon.stub().returns({
          _trace: trace,
          _sampling: {},
          getTags: () => tagsA,
          getTag: (key) => tagsA[key],
          setTag: (key, value) => { tagsA[key] = value },
          hasTag: (key) => key in tagsA,
          clearTags: () => { tagsA = Object.create(null) },
        }),
        _duration: 100,
      }
      const spanB = {
        tracer: sinon.stub().returns(tracer),
        context: sinon.stub().returns({
          _trace: trace,
          _sampling: {},
          getTags: () => tagsB,
          getTag: (key) => tagsB[key],
          setTag: (key, value) => { tagsB[key] = value },
          hasTag: (key) => key in tagsB,
          clearTags: () => { tagsB = Object.create(null) },
        }),
        _duration: 200,
      }
      spanA.context().setTag('service.name', 'service-a')
      spanB.context().setTag('service.name', 'service-b')

      trace.started = [spanA, spanB]
      trace.finished = [spanA, spanB]
      processor.process(spanA)

      sinon.assert.calledWith(registerExtraService, 'service-a')
      sinon.assert.calledWith(registerExtraService, 'service-b')
    })
  })

  describe('native sampling sync', () => {
    it('should mirror sampling priority and mechanism to native storage', () => {
      const ctx = {
        _trace: { tags: {} },
        _sampling: { priority: 1, mechanism: 4 },
      }

      processor._syncSamplingToNative(ctx, 0)

      sinon.assert.calledTwice(nativeSpans.queueOp)
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        0,
        '_sampling_priority_v1',
        ['f64', 1]
      )
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetaAttr,
        0,
        '_dd.p.dm',
        '-4'
      )
    })

    it('should forward sampling-decision metrics when present', () => {
      const ctx = {
        _trace: {
          tags: {},
          '_dd.rule_psr': 1.5,
          '_dd.limit_psr': 0.8,
          '_dd.agent_psr': 0,
        },
        _sampling: { priority: 1, mechanism: 1 },
      }

      processor._syncSamplingToNative(ctx, 42)

      // 5 calls: priority, mechanism, rule_psr, limit_psr, agent_psr
      sinon.assert.callCount(nativeSpans.queueOp, 5)
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        42,
        '_dd.rule_psr',
        ['f64', 1.5]
      )
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        42,
        '_dd.limit_psr',
        ['f64', 0.8]
      )
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        42,
        '_dd.agent_psr',
        ['f64', 0]
      )
    })

    it('should skip sampling-decision metrics when absent', () => {
      const ctx = {
        _trace: { tags: {} },
        _sampling: { priority: 1, mechanism: 3 },
      }

      processor._syncSamplingToNative(ctx, 0)

      // Only 2 calls: priority + mechanism, no decision metrics
      sinon.assert.callCount(nativeSpans.queueOp, 2)
    })

    it('should forward only rule_psr when it is the sole decision metric', () => {
      const ctx = {
        _trace: {
          tags: {},
          '_dd.rule_psr': 2.0,
        },
        _sampling: { priority: 1, mechanism: 1 },
      }

      processor._syncSamplingToNative(ctx, 7)

      // 3 calls: priority, mechanism, rule_psr
      sinon.assert.callCount(nativeSpans.queueOp, 3)
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        7,
        '_dd.rule_psr',
        ['f64', 2.0]
      )
    })

    it('should forward rule_psr and agent_psr when limit_psr is absent', () => {
      const ctx = {
        _trace: {
          tags: {},
          '_dd.rule_psr': 0.5,
          '_dd.agent_psr': 1.0,
        },
        _sampling: { priority: 2, mechanism: 2 },
      }

      processor._syncSamplingToNative(ctx, 9)

      // 4 calls: priority, mechanism, rule_psr, agent_psr
      sinon.assert.callCount(nativeSpans.queueOp, 4)
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        9,
        '_dd.rule_psr',
        ['f64', 0.5]
      )
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        9,
        '_dd.agent_psr',
        ['f64', 1.0]
      )
    })
  })
})
