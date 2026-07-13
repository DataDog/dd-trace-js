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
        DD_TRACE_STATS_COMPUTATION_ENABLED: false,
      },
      appsec: {},
    }

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample,
    })

    fakeOpCode = {
      SetTraceMetricsAttr: 11,
      SetTraceMetaAttr: 10,
      SetMetaAttr: 12,
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

  it('should feed formatted spans to OTLP stats while exporting raw spans natively', () => {
    const formattedSpan = { name: 'formatted', metrics: {}, meta: {} }
    const spanFormat = sinon.stub().returns(formattedSpan)
    const onSpanFinished = sinon.stub()
    const SpanStatsProcessor = sinon.stub().returns({ onSpanFinished })
    const SpanProcessorWithStats = proxyquire('../src/span_processor', {
      './span_format': spanFormat,
      './span_sampler': SpanSampler,
      './native': { OpCode: fakeOpCode },
      './span_stats': { SpanStatsProcessor },
      './service-naming/extra-services': extraServicesStub,
    })
    const otlpStatsExporter = { export: sinon.stub() }
    const processorWithStats = new SpanProcessorWithStats(
      exporter,
      prioritySampler,
      config,
      nativeSpans,
      otlpStatsExporter
    )

    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processorWithStats.process(finishedSpan)

    sinon.assert.calledWithNew(SpanStatsProcessor)
    sinon.assert.calledWith(SpanStatsProcessor, config, otlpStatsExporter)
    sinon.assert.calledOnceWithExactly(spanFormat, finishedSpan, true, false)
    sinon.assert.calledOnceWithExactly(onSpanFinished, formattedSpan)
    sinon.assert.calledOnceWithExactly(exporter.export, [finishedSpan])
  })

  it('stamps process tags as span meta on the native chunk root before export', () => {
    const processTagsSerialized = 'entrypoint.workdir:test,svc.user:true'
    const SpanProcessorWithProcessTags = proxyquire('../src/span_processor', {
      './span_sampler': SpanSampler,
      './native': { OpCode: fakeOpCode },
      './process-tags': {
        TRACING_FIELD_NAME: '_dd.tags.process',
        serialized: processTagsSerialized,
      },
      './service-naming/extra-services': extraServicesStub,
    })
    const processorWithProcessTags = new SpanProcessorWithProcessTags(
      exporter,
      prioritySampler,
      {
        ...config,
        flushMinSpans: 2,
        DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true,
      },
      nativeSpans
    )
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1
      c._sampling.mechanism = 3
    })

    const active = createProcessorSpan(999, null)
    active._duration = undefined
    const child = createProcessorSpan(123, active.context()._spanId)
    const localRoot = createProcessorSpan(456, { toString: () => 'remote-parent' })
    localRoot.context()._isRemote = true
    // Partial flush: the active root is still in trace.started but is not
    // exported. The first exported span is a child; the later remote-parent
    // span is the local root and must receive the chunk process tag.
    trace.tags = {}
    trace.started = [active, child, localRoot]
    trace.finished = [child, localRoot]

    processorWithProcessTags.process(localRoot)

    sinon.assert.calledWith(
      nativeSpans.queueOp,
      fakeOpCode.SetMetaAttr,
      localRoot.context()._nativeSpanId,
      '_dd.tags.process',
      processTagsSerialized
    )
    assert.strictEqual(
      nativeSpans.queueOp.getCalls().some(call =>
        call.args[0] === fakeOpCode.SetMetaAttr &&
        call.args[1] === child.context()._nativeSpanId &&
        call.args[2] === '_dd.tags.process'
      ),
      false
    )
  })

  it('writes _dd.p.dm to native trace meta for kept traces (priority >= AUTO_KEEP)', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 123
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1 // AUTO_KEEP
      c._sampling.mechanism = 3
    })
    processor.process(finishedSpan)
    const dm = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.p.dm')
    assert.strictEqual(dm.length, 1)
    assert.strictEqual(dm[0].args[3], '-3')
    // _addDecisionMaker also tags the JS trace (exported via #syncTraceTags).
    assert.strictEqual(trace.tags['_dd.p.dm'], '-3')
  })

  it('omits _dd.p.dm for dropped traces (priority < AUTO_KEEP)', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 123
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 0 // AUTO_REJECT
      c._sampling.mechanism = 3
    })
    processor.process(finishedSpan)
    const dm = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.p.dm')
    assert.strictEqual(dm.length, 0)
    // and _addDecisionMaker must not tag the dropped trace either (C7).
    assert.strictEqual(trace.tags['_dd.p.dm'], undefined)
  })

  it('emits an extracted _dd.p.dm (from trace.tags) even when no local mechanism is set', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 123
    // Distributed extract sets _dd.p.dm on trace.tags with no local mechanism.
    trace.tags['_dd.p.dm'] = '-4'
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1 // kept, mechanism stays undefined (extracted)
    })
    processor.process(finishedSpan)
    const dm = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.p.dm')
    assert.strictEqual(dm.length, 1)
    assert.strictEqual(dm[0].args[3], '-4')
  })

  it('mirrors a pre-set sampling priority (AppSec/manual keep, propagation) without re-sampling', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    const ctx = finishedSpan.context()
    ctx._nativeSpanId = 123
    // Priority decided before the span is processed (e.g. AppSec force-keep).
    ctx._sampling.priority = 2 // USER_KEEP
    ctx._sampling.mechanism = 4

    processor.process(finishedSpan)

    // A priority is already set, so we must not re-run the sampler...
    sinon.assert.notCalled(prioritySampler.sample)
    // ...but the priority must still be mirrored to native storage, otherwise
    // the WASM exporter omits `_sampling_priority_v1` (regression that broke the
    // AppSec system-tests: KeyError '_sampling_priority_v1').
    const prio = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetricsAttr && c.args[2] === '_sampling_priority_v1')
    assert.strictEqual(prio.length, 1)
    assert.deepStrictEqual(prio[0].args[3], ['f64', 2])
  })

  it('mirrors trace propagation tags (_dd.p.tid) to native trace meta', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 55
    // 128-bit trace-id high bits carried as a trace-level propagation tag.
    trace.tags['_dd.p.tid'] = '640cfd8d00000000'
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1
      c._sampling.mechanism = 3
    })

    processor.process(finishedSpan)

    const tid = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.p.tid')
    assert.strictEqual(tid.length, 1)
    assert.strictEqual(tid[0].args[3], '640cfd8d00000000')
    // `_dd.p.dm` is written by the sampling path only — the trace-tags sync
    // skips it, so it must still appear exactly once (no duplicate).
    const dm = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.p.dm')
    assert.strictEqual(dm.length, 1)
  })

  it('mirrors the trace origin (_dd.origin) to native trace meta', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 55
    // `_dd.origin` lives on `_trace.origin`, not `_trace.tags`.
    trace.origin = 'synthetics'
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1
      c._sampling.mechanism = 3
    })

    processor.process(finishedSpan)

    const origin = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr && c.args[2] === '_dd.origin')
    assert.strictEqual(origin.length, 1)
    assert.strictEqual(origin[0].args[3], 'synthetics')
  })

  it('mirrors git metadata trace tags to native (tagGitMetadata runs after sample)', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._nativeSpanId = 77
    // GitMetadataTagger writes `_dd.git.*` onto trace.tags during process(),
    // AFTER sample(); the trace-tags sync must run after it or these are lost.
    processor._gitMetadataTagger = {
      tagGitMetadata: (ctx) => {
        ctx._trace.tags['_dd.git.repository_url'] = 'https://github.com/x/y'
        ctx._trace.tags['_dd.git.commit.sha'] = 'abc123'
      },
    }
    prioritySampler.sample = sinon.stub().callsFake((c) => {
      c._sampling.priority = 1
      c._sampling.mechanism = 3
    })

    processor.process(finishedSpan)

    const metaKeys = nativeSpans.queueOp.getCalls()
      .filter(c => c.args[0] === fakeOpCode.SetTraceMetaAttr)
      .map(c => c.args[2])
    assert.ok(metaKeys.includes('_dd.git.repository_url'), 'expected _dd.git.repository_url synced to native')
    assert.ok(metaKeys.includes('_dd.git.commit.sha'), 'expected _dd.git.commit.sha synced to native')
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
      stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false },
      appsec: {},
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
      DD_TRACE_ENABLED: false,
      stats: {
        DD_TRACE_STATS_COMPUTATION_ENABLED: false,
      },
      appsec: {},
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

  function createProcessorSpan (nativeSpanId, parentId) {
    const tags = Object.create(null)
    const spanId = {
      toString: () => String(nativeSpanId),
    }
    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: parentId,
      _isRemote: false,
      _trace: trace,
      _sampling: {},
      getTags: () => tags,
      getTag: (key) => tags[key],
      setTag: (key, value) => { tags[key] = value },
      hasTag: (key) => key in tags,
      clearTags: () => {
        for (const key of Object.keys(tags)) delete tags[key]
      },
    }

    return {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns(context),
      _duration: 100,
    }
  }
  describe('native sampling sync', () => {
    it('should mirror sampling priority to native storage', () => {
      const ctx = {
        _trace: { tags: {} },
        _sampling: { priority: 1, mechanism: 4 },
      }

      processor._syncSamplingToNative(ctx, 0)

      // `_dd.p.dm` is no longer emitted here — _addDecisionMaker sets it on
      // trace.tags and _syncTraceTagsToNative mirrors it.
      sinon.assert.calledOnce(nativeSpans.queueOp)
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        fakeOpCode.SetTraceMetricsAttr,
        0,
        '_sampling_priority_v1',
        ['f64', 1]
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

      // 4 calls: priority, rule_psr, limit_psr, agent_psr (_dd.p.dm moved out)
      sinon.assert.callCount(nativeSpans.queueOp, 4)
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

      // Only 1 call: priority (_dd.p.dm moved out), no decision metrics
      sinon.assert.callCount(nativeSpans.queueOp, 1)
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

      // 2 calls: priority, rule_psr (_dd.p.dm moved out)
      sinon.assert.callCount(nativeSpans.queueOp, 2)
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

      // 3 calls: priority, rule_psr, agent_psr (_dd.p.dm moved out)
      sinon.assert.callCount(nativeSpans.queueOp, 3)
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
