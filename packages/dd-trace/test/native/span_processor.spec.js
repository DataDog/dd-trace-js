'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

require('../setup/core')

const {
  APM_TRACING_ENABLED_KEY,
  ORIGIN_KEY,
  SAMPLING_AGENT_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_RULE_DECISION,
} = require('../../src/constants')

function createTrace () {
  return { started: [], finished: [], tags: {} }
}

function createSpan (id, trace, options = {}) {
  const tags = { ...options.tags }
  const context = {
    _nativeSpanId: Uint8Array.of(id),
    _parentId: options.parentId ?? null,
    _isRemote: options.isRemote ?? false,
    _sampling: options.sampling ?? {},
    _trace: trace,
    applyOtelHttpSemantics: sinon.stub(),
    getTag: key => tags[key],
    getTags: () => tags,
    hasTag: key => Object.hasOwn(tags, key),
    markExported: sinon.stub(),
    setTag: (key, value) => { tags[key] = value },
    syncFinalTagsToNative: sinon.stub(),
  }
  const span = {
    _duration: options.finished === false ? undefined : 100,
    _finished: options.finished !== false,
    _tryFastNativeFinalSync: sinon.stub().returns(options.fastSync ?? false),
    context: () => context,
    finish: sinon.stub(),
  }
  trace.started.push(span)
  if (options.finished !== false) trace.finished.push(span)
  return span
}

describe('NativeSpanProcessor', () => {
  let NativeSpanProcessor
  let SpanStatsProcessor
  let SpanSampler
  let config
  let exporter
  let gitMetadataTagger
  let nativeSpans
  let prioritySampler
  let spanFormat
  let statsFinished

  beforeEach(() => {
    config = {
      appsec: {},
      flushMinSpans: 3,
      sampler: {},
      stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false },
    }
    exporter = {
      _discardNativeSpans: sinon.stub().returns(true),
      _resetNativeStateWhenIdle: sinon.stub(),
      export: sinon.stub(),
    }
    nativeSpans = { queueOp: sinon.stub() }
    prioritySampler = {
      sample: sinon.stub().callsFake(context => {
        context._sampling.priority ??= 1
        context._sampling.mechanism ??= 0
        context._trace.tags['_dd.p.dm'] ??= '-0'
      }),
    }
    spanFormat = sinon.stub().returns({
      name: 'operation',
      resource: 'resource',
      service: 'service',
      type: 'web',
      meta: {},
      metrics: {},
      start: 1,
      duration: 1,
      error: 0,
    })
    statsFinished = sinon.stub()
    SpanStatsProcessor = sinon.stub().returns({ onSpanFinished: statsFinished })
    SpanSampler = sinon.stub().returns({ sample: sinon.stub() })
    gitMetadataTagger = { tagGitMetadata: sinon.stub() }
    const GitMetadataTagger = sinon.stub().returns(gitMetadataTagger)
    const OpCode = {
      SetMetaAttr: 1,
      SetTraceMetaAttr: 2,
      SetTraceMetricsAttr: 3,
    }
    const processTags = { TRACING_FIELD_NAME: '_dd.tags.process', serialized: 'k:v' }

    const BaseSpanProcessor = proxyquire('../../src/span_processor', {
      './git_metadata_tagger': GitMetadataTagger,
      './span_format': spanFormat,
      './span_sampler': SpanSampler,
      './span_stats': { SpanStatsProcessor },
      './process-tags': processTags,
    })
    NativeSpanProcessor = proxyquire('../../src/native_span_processor', {
      './native': { OpCode },
      './process-tags': processTags,
      './span_format': spanFormat,
      './span_processor': BaseSpanProcessor,
    })
  })

  function createProcessor () {
    return new NativeSpanProcessor(exporter, prioritySampler, config, nativeSpans)
  }

  it('applies JS sampling and mirrors priority plus decision metrics', () => {
    const trace = createTrace()
    trace[SAMPLING_RULE_DECISION] = 0.5
    trace[SAMPLING_LIMIT_DECISION] = 0.75
    trace[SAMPLING_AGENT_DECISION] = 0.25
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.sample(span)

    sinon.assert.calledOnceWithExactly(prioritySampler.sample, span.context())
    assert(nativeSpans.queueOp.calledWith(3, span.context()._nativeSpanId, '_sampling_priority_v1', ['f64', 1]))
    assert(nativeSpans.queueOp.calledWith(3, span.context()._nativeSpanId, SAMPLING_RULE_DECISION, ['f64', 0.5]))
    assert(nativeSpans.queueOp.calledWith(3, span.context()._nativeSpanId, SAMPLING_LIMIT_DECISION, ['f64', 0.75]))
    assert(nativeSpans.queueOp.calledWith(3, span.context()._nativeSpanId, SAMPLING_AGENT_DECISION, ['f64', 0.25]))
  })

  it('exports raw spans after final native synchronization', () => {
    const trace = createTrace()
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.process(span)

    sinon.assert.calledOnceWithExactly(exporter.export, [span])
    sinon.assert.calledOnce(span.context().syncFinalTagsToNative)
    sinon.assert.calledOnce(span.context().markExported)
    sinon.assert.calledOnce(gitMetadataTagger.tagGitMetadata)
  })

  it('uses the allocation-light final sync when stats are disabled', () => {
    const trace = createTrace()
    const span = createSpan(1, trace, { fastSync: true })
    const processor = createProcessor()

    processor.process(span)

    sinon.assert.notCalled(spanFormat)
    sinon.assert.notCalled(span.context().syncFinalTagsToNative)
    sinon.assert.calledOnceWithExactly(exporter.export, [span])
  })

  it('runs JS client stats before native final synchronization', () => {
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
    const trace = createTrace()
    const span = createSpan(1, trace, { fastSync: true })
    const processor = createProcessor()

    processor.process(span)

    sinon.assert.calledOnce(SpanStatsProcessor)
    sinon.assert.calledOnce(statsFinished)
    sinon.assert.calledOnce(span.context().syncFinalTagsToNative)
    assert(statsFinished.calledBefore(span.context().syncFinalTagsToNative))
  })

  it('exports only finished spans at a partial flush threshold', () => {
    config.flushMinSpans = 1
    const trace = createTrace()
    const root = createSpan(1, trace, { finished: false })
    const child = createSpan(2, trace, { parentId: Uint8Array.of(1) })
    const processor = createProcessor()

    processor.process(child)

    sinon.assert.calledOnceWithExactly(exporter.export, [child])
    assert.deepStrictEqual(trace.started, [root])
    assert.deepStrictEqual(trace.finished, [])
  })

  it('discards all native state when tracing is disabled', () => {
    config.DD_TRACE_ENABLED = false
    const trace = createTrace()
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.process(span)

    sinon.assert.calledOnceWithExactly(exporter._discardNativeSpans, [span])
    sinon.assert.calledOnce(span.context().markExported)
    sinon.assert.notCalled(exporter.export)
    sinon.assert.notCalled(exporter._resetNativeStateWhenIdle)
  })

  it('rebuilds idle native state only when targeted discard fails', () => {
    exporter._discardNativeSpans.returns(false)
    const trace = createTrace()
    trace.record = false
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.process(span)

    sinon.assert.calledOnce(exporter._resetNativeStateWhenIdle)
  })

  it('mirrors trace tags, origin, and process tags', () => {
    config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = true
    const trace = createTrace()
    trace.tags['_dd.p.dm'] = '-1'
    trace.tags.numeric = 2
    trace.origin = 'synthetics'
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.process(span)

    assert(nativeSpans.queueOp.calledWith(2, span.context()._nativeSpanId, '_dd.p.dm', '-1'))
    assert(nativeSpans.queueOp.calledWith(3, span.context()._nativeSpanId, 'numeric', ['f64', 2]))
    assert(nativeSpans.queueOp.calledWith(2, span.context()._nativeSpanId, ORIGIN_KEY, 'synthetics'))
    assert(nativeSpans.queueOp.calledWith(1, span.context()._nativeSpanId, '_dd.tags.process', 'k:v'))
  })

  it('stamps standalone APM and applies OTel HTTP semantics', () => {
    config.apmTracingEnabled = false
    config.DD_TRACE_OTEL_SEMANTICS_ENABLED = true
    const trace = createTrace()
    const span = createSpan(1, trace)
    const processor = createProcessor()

    processor.process(span)

    assert.strictEqual(span.context().getTag(APM_TRACING_ENABLED_KEY), 0)
    sinon.assert.calledOnce(span.context().applyOtelHttpSemantics)
  })

  it('finishes active spans after killAll is requested', () => {
    config.flushMinSpans = 1
    const trace = createTrace()
    const active = createSpan(1, trace, { finished: false })
    const finished = createSpan(2, trace)
    const processor = createProcessor()
    processor.killAll()

    processor.process(finished)

    sinon.assert.calledOnce(active.finish)
  })
})
