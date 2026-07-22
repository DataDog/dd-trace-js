'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('./setup/core')

const { APM_TRACING_ENABLED_KEY } = require('../src/constants')

describe('JsSpanProcessor', () => {
  let exporter
  let prioritySampler
  let config
  let trace
  let spanFormat
  let SpanSampler
  let sample
  let tagGitMetadata
  let GitMetadataTagger
  let SpanStatsProcessor
  let onSpanFinished
  let JsSpanProcessor

  beforeEach(() => {
    exporter = { export: sinon.stub() }
    prioritySampler = { sample: sinon.stub() }
    config = {
      flushMinSpans: 3,
      stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false },
      sampler: {},
    }
    trace = { started: [], finished: [], tags: {} }

    spanFormat = sinon.stub().callsFake((span, isFirstSpanInChunk) => ({
      name: span.name,
      meta: {},
      metrics: {},
      isFirstSpanInChunk,
    }))
    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({ sample })
    tagGitMetadata = sinon.stub()
    GitMetadataTagger = sinon.stub().returns({ tagGitMetadata })
    onSpanFinished = sinon.stub()
    SpanStatsProcessor = sinon.stub().returns({ onSpanFinished })

    JsSpanProcessor = proxyquire('../src/js_span_processor', {
      './span_format': spanFormat,
      './span_sampler': SpanSampler,
      './git_metadata_tagger': GitMetadataTagger,
      './span_stats': { SpanStatsProcessor },
      './process-tags': { serialized: false },
      './plugins/util/http-otel-semantics': { applyHttpOtelSemantics: sinon.stub() },
    })
  })

  function createSpan (name) {
    const tags = Object.create(null)
    const context = {
      _trace: trace,
      _sampling: {},
      getTags: () => tags,
      getTag: key => tags[key],
      setTag: (key, value) => { tags[key] = value },
      hasTag: key => key in tags,
      clearTags: () => {
        for (const key of Object.keys(tags)) delete tags[key]
      },
    }

    return {
      name,
      _duration: 100,
      context: sinon.stub().returns(context),
    }
  }

  it('computes v0.6 APM stats when client-side stats are enabled', () => {
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
    const processor = new JsSpanProcessor(exporter, prioritySampler, config)
    const span = createSpan('web.request')
    trace.started = [span]
    trace.finished = [span]

    processor.process(span)

    sinon.assert.calledWithNew(SpanStatsProcessor)
    sinon.assert.calledOnceWithExactly(SpanStatsProcessor, config, undefined)
    sinon.assert.calledOnce(spanFormat)
    sinon.assert.calledOnceWithExactly(onSpanFinished, spanFormat.firstCall.returnValue)
    sinon.assert.calledOnceWithExactly(exporter.export, [spanFormat.firstCall.returnValue])
  })

  it('does not compute APM stats for CI Visibility spans', () => {
    config.isCiVisibility = true
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
    const processor = new JsSpanProcessor(exporter, prioritySampler, config)
    const span = createSpan('ci.test')
    trace.started = [span]
    trace.finished = [span]

    processor.process(span)

    sinon.assert.notCalled(SpanStatsProcessor)
    sinon.assert.notCalled(onSpanFinished)
    sinon.assert.calledOnceWithExactly(exporter.export, [spanFormat.firstCall.returnValue])
  })

  it('uses an injected OTLP span metrics exporter when provided', () => {
    const otlpStatsExporter = { export: sinon.stub() }
    const processor = new JsSpanProcessor(exporter, prioritySampler, config, otlpStatsExporter)
    const span = createSpan('web.request')
    trace.started = [span]
    trace.finished = [span]

    processor.process(span)

    sinon.assert.calledWithNew(SpanStatsProcessor)
    sinon.assert.calledOnceWithExactly(SpanStatsProcessor, config, otlpStatsExporter)
    sinon.assert.calledOnceWithExactly(onSpanFinished, spanFormat.firstCall.returnValue)
  })

  it('stamps the APM-disabled marker on the first finished span in each chunk', () => {
    config.apmTracingEnabled = false
    const processor = new JsSpanProcessor(exporter, prioritySampler, config)
    const first = createSpan('first')
    const second = createSpan('second')
    trace.started = [first, second]
    trace.finished = [first, second]

    processor.process(first)

    assert.strictEqual(first.context().getTag(APM_TRACING_ENABLED_KEY), 0)
    assert.strictEqual(second.context().getTag(APM_TRACING_ENABLED_KEY), undefined)
    sinon.assert.calledWithExactly(spanFormat.firstCall, first, true, false)
    sinon.assert.calledWithExactly(spanFormat.secondCall, second, false, false)
  })
})
