'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

const { APM_TRACING_ENABLED_KEY, SDK_OTLP_EXPORT_KEY } = require('../src/constants')
const { AUTO_REJECT, USER_KEEP, USER_REJECT } = require('../../../ext/priority')
const TraceState = require('../src/opentracing/propagation/tracestate')

describe('SpanProcessor', () => {
  let prioritySampler
  let processor
  let SpanProcessor
  let activeSpan
  let finishedSpan
  let trace
  let exporter
  let tracer
  let spanFormat
  let config
  let SpanSampler
  let SpanStatsProcessor
  let updateOtelTraceState
  let sample

  before(() => {
    require('../src/process-tags').initialize()
  })

  beforeEach(() => {
    tracer = {}
    trace = {
      started: [],
      finished: [],
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
    }
    config = {
      flushMinSpans: 3,
      stats: {
        DD_TRACE_STATS_COMPUTATION_ENABLED: false,
      },
      appsec: {},
    }
    spanFormat = sinon.stub().callsFake(() => ({ formatted: true, meta: {} }))
    updateOtelTraceState = sinon.stub().callsFake((context, traceState) => {
      traceState.set('ot', 'rv:ef284ace7a91e1;th:e6666666666668')
    })

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample,
    })
    SpanStatsProcessor = sinon.stub()

    SpanProcessor = proxyquire('../src/span_processor', {
      './span_format': spanFormat,
      './span_sampler': SpanSampler,
      './span_stats': { SpanStatsProcessor },
      './otel-sampling': { updateOtelTraceState },
    })
    processor = new SpanProcessor(exporter, prioritySampler, config)
  })

  it('should configure span stats when enabled outside standalone AppSec', () => {
    const otlpStatsExporter = {}
    const stats = {}
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
    config.appsec.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = false
    SpanStatsProcessor.returns(stats)

    const processor = new SpanProcessor(exporter, prioritySampler, config, otlpStatsExporter)

    sinon.assert.calledOnceWithExactly(SpanStatsProcessor, config, otlpStatsExporter)
    assert.strictEqual(processor._stats, stats)
  })

  it('should not configure span stats in standalone AppSec', () => {
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
    config.appsec.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = true

    const processor = new SpanProcessor(exporter, prioritySampler, config)

    sinon.assert.notCalled(SpanStatsProcessor)
    assert.strictEqual(processor._stats, undefined)
  })

  it('should generate sampling priority', () => {
    processor.process(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should generate sampling priority when sampling manually', () => {
    processor.sample(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should span sample when the trace is not marked for discard', () => {
    processor.sample(finishedSpan)

    sinon.assert.calledWith(sample, finishedSpan.context())
  })

  it('should skip span sampling when the priority sampler marks the trace for discard', () => {
    prioritySampler.sample = sinon.stub().callsFake((context) => {
      context._sampling.discard = true
      context._sampling.priority = AUTO_REJECT
    })

    processor.sample(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
    sinon.assert.notCalled(sample)
  })

  it('should still span sample when discard was set but the priority was later force-kept', () => {
    // e.g. a product forcing the trace to be kept via PrioritySampler.keepTrace() after a
    // sampling rule already rejected it and flagged it for discard.
    finishedSpan.context()._sampling.discard = true
    finishedSpan.context()._sampling.priority = AUTO_REJECT
    finishedSpan.context()._sampling.priority = USER_KEEP

    processor.sample(finishedSpan)

    sinon.assert.calledWith(sample, finishedSpan.context())
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
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan]
    processor.process(finishedSpan)

    sinon.assert.calledWith(exporter.export, [
      { formatted: true, meta: { [SDK_OTLP_EXPORT_KEY]: 'false' } },
      { formatted: true, meta: {} },
      { formatted: true, meta: {} },
    ])

    assert.ok('started' in trace)
    assert.deepStrictEqual(trace.started, [activeSpan])
    assert.ok('finished' in trace)
    assert.deepStrictEqual(trace.finished, [])
  })

  it('should drop the chunk without exporting or formatting when marked for discard', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._sampling.discard = true
    finishedSpan.context()._sampling.priority = AUTO_REJECT

    processor.process(finishedSpan)

    sinon.assert.notCalled(exporter.export)
    sinon.assert.notCalled(spanFormat)
    assert.deepStrictEqual(trace.started, [])
    assert.deepStrictEqual(trace.finished, [])
  })

  it('should not record span stats for a chunk marked for discard', () => {
    processor._stats = { onSpanFinished: sinon.stub() }
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._sampling.discard = true
    finishedSpan.context()._sampling.priority = AUTO_REJECT

    processor.process(finishedSpan)

    sinon.assert.notCalled(processor._stats.onSpanFinished)
  })

  it('should keep not-yet-finished spans active when a chunk is discarded', () => {
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan]
    finishedSpan.context()._sampling.discard = true
    finishedSpan.context()._sampling.priority = AUTO_REJECT

    processor.process(finishedSpan)

    sinon.assert.notCalled(exporter.export)
    assert.deepStrictEqual(trace.started, [activeSpan])
    assert.deepStrictEqual(trace.finished, [])
  })

  it('should still export the chunk when discard was set but the priority was later force-kept', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    finishedSpan.context()._sampling.discard = true
    finishedSpan.context()._sampling.priority = USER_KEEP

    processor.process(finishedSpan)

    sinon.assert.calledWith(exporter.export, [{ formatted: true, meta: { [SDK_OTLP_EXPORT_KEY]: 'false' } }])
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

    const processor = new SpanProcessor(exporter, prioritySampler, config)
    processor.process(finishedSpan)

    sinon.assert.calledWith(SpanSampler, config.sampler)
  })

  it('should erase the trace and stop execution when tracing=false', () => {
    const config = {
      DD_TRACE_ENABLED: false,
      stats: {
        DD_TRACE_STATS_COMPUTATION_ENABLED: false,
      },
      appsec: {},
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config)
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

  it('should call spanFormat every time a partial flush is triggered', () => {
    config.flushMinSpans = 1
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [activeSpan, finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(activeSpan)

    assert.ok('started' in trace)
    assert.deepStrictEqual(trace.started, [activeSpan])
    assert.ok('finished' in trace)
    assert.deepStrictEqual(trace.finished, [])
    assert.strictEqual(spanFormat.callCount, 1)
    sinon.assert.calledWith(spanFormat, finishedSpan, true)
  })

  it('should add span tags to first span in a chunk', () => {
    config.flushMinSpans = 2
    config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = true
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan, finishedSpan]
    processor.process(activeSpan)
    const tags = processor._processTags

    {
      let foundATag = false
      tags.split(',').forEach(tag => {
        const [key, value] = tag.split(':')
        if (key !== 'entrypoint.basedir') return
        // The exact basedir varies depending on the test runner location
        // (e.g. "test" in source tree vs "bin" when run via node_modules/.bin/mocha).
        assert.ok(
          typeof value === 'string' && value.length > 0,
          `entrypoint.basedir value: ${inspect(value)}`
        )
        foundATag = true
      })
      assert.ok(foundATag)
    }

    sinon.assert.calledWith(spanFormat.getCall(0), finishedSpan, true, processor._processTags)
    sinon.assert.calledWith(spanFormat.getCall(1), finishedSpan, false, processor._processTags)
    sinon.assert.calledWith(spanFormat.getCall(2), finishedSpan, false, processor._processTags)
    sinon.assert.calledWith(spanFormat.getCall(3), finishedSpan, false, processor._processTags)
  })

  it('should add the native export marker to the first span of each chunk', () => {
    config.flushMinSpans = 2
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [activeSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan]
    processor.process(finishedSpan)

    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    const [firstChunk] = exporter.export.firstCall.args
    const [secondChunk] = exporter.export.secondCall.args
    assert.strictEqual(firstChunk[0].meta[SDK_OTLP_EXPORT_KEY], 'false')
    assert.ok(!Object.hasOwn(firstChunk[1].meta, SDK_OTLP_EXPORT_KEY))
    assert.strictEqual(secondChunk[0].meta[SDK_OTLP_EXPORT_KEY], 'false')
  })

  it('should not let a span tag override the native export marker', () => {
    config.flushMinSpans = 1
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    const formattedSpan = { meta: { [SDK_OTLP_EXPORT_KEY]: 'true' } }
    spanFormat.returns(formattedSpan)
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    assert.strictEqual(formattedSpan.meta[SDK_OTLP_EXPORT_KEY], 'false')
  })

  it('should not add the native export marker when traces are exported over OTLP', () => {
    config.flushMinSpans = 1
    config.OTEL_TRACES_EXPORTER = 'otlp'
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    const [chunk] = exporter.export.firstCall.args
    assert.ok(!Object.hasOwn(chunk[0].meta, SDK_OTLP_EXPORT_KEY))
  })

  it('should add live tracestate to spans exported through OTLP', () => {
    config.OTEL_TRACES_EXPORTER = 'otlp'
    const formattedSpan = { meta: {}, metrics: {} }
    spanFormat.returns(formattedSpan)
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    const context = finishedSpan.context()
    context._tracestate = TraceState.fromString('dd=s:1,congo=value')
    const processor = new SpanProcessor(exporter, prioritySampler, config, undefined, true)

    processor.process(finishedSpan)

    assert.strictEqual(formattedSpan.trace_state, 'ot=rv:ef284ace7a91e1;th:e6666666666668,dd=s:1,congo=value')
    assert.strictEqual(context._tracestate.toString(), 'dd=s:1,congo=value')
    sinon.assert.calledOnceWithExactly(updateOtelTraceState, context, sinon.match.instanceOf(TraceState))
    sinon.assert.calledWith(exporter.export, [formattedSpan])
  })

  it('should not build tracestate for the Datadog exporter', () => {
    const formattedSpan = { meta: {}, metrics: {} }
    spanFormat.returns(formattedSpan)
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    assert.ok(!Object.hasOwn(formattedSpan, 'trace_state'))
    sinon.assert.notCalled(updateOtelTraceState)
  })

  for (const priority of [AUTO_REJECT, USER_REJECT]) {
    it(`should retain stats without building OTLP tracestate for priority ${priority}`, () => {
      config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true
      const stats = { onSpanFinished: sinon.stub() }
      SpanStatsProcessor.returns(stats)
      const formattedSpan = { meta: {}, metrics: {} }
      spanFormat.returns(formattedSpan)
      trace.started = [finishedSpan]
      trace.finished = [finishedSpan]
      finishedSpan.context()._sampling.priority = priority
      const processor = new SpanProcessor(exporter, prioritySampler, config, undefined, true)

      processor.process(finishedSpan)

      assert.ok(!Object.hasOwn(formattedSpan, 'trace_state'))
      sinon.assert.notCalled(updateOtelTraceState)
      sinon.assert.calledOnceWithExactly(stats.onSpanFinished, formattedSpan)
      sinon.assert.calledOnceWithExactly(exporter.export, [formattedSpan])
    })
  }

  it('should add APM disabled marker to every span in a chunk when APM tracing is disabled', () => {
    config.apmTracingEnabled = false
    config.flushMinSpans = 2
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    const firstFormatted = { meta: {}, metrics: {} }
    const secondFormatted = { meta: {}, metrics: {} }
    spanFormat.onFirstCall().returns(firstFormatted)
    spanFormat.onSecondCall().returns(secondFormatted)
    trace.started = [activeSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan]

    processor.process(finishedSpan)

    assert.strictEqual(firstFormatted.metrics[APM_TRACING_ENABLED_KEY], 0)
    assert.strictEqual(secondFormatted.metrics[APM_TRACING_ENABLED_KEY], 0)
    sinon.assert.calledWith(exporter.export, [firstFormatted, secondFormatted])
  })

  it('should add APM disabled marker to every chunk when a delayed child flushes alone', () => {
    // Reproduces the standalone-ASM billing regression: the entry span flushes
    // in one chunk, then a long-lived child (e.g. delayed http.request) flushes
    // later in its own chunk. Both chunks must carry _dd.apm.enabled:0.
    config.apmTracingEnabled = false
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    const parentFormatted = { meta: {}, metrics: {} }
    const childFormatted = { meta: {}, metrics: {} }
    spanFormat.onFirstCall().returns(parentFormatted)
    spanFormat.onSecondCall().returns(childFormatted)

    const parentSpan = { ...finishedSpan }
    const childSpan = { ...finishedSpan }
    trace.started = [parentSpan]
    trace.finished = [parentSpan]

    processor.process(parentSpan)

    assert.strictEqual(parentFormatted.metrics[APM_TRACING_ENABLED_KEY], 0)
    sinon.assert.calledWith(exporter.export, [parentFormatted])

    trace.started = [childSpan]
    trace.finished = [childSpan]

    processor.process(childSpan)

    assert.strictEqual(childFormatted.metrics[APM_TRACING_ENABLED_KEY], 0)
    sinon.assert.calledWith(exporter.export.secondCall, [childFormatted])
  })

  it('should not add APM disabled marker when APM tracing is enabled', () => {
    config.apmTracingEnabled = true
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    const formattedSpan = { meta: {}, metrics: {} }
    spanFormat.returns(formattedSpan)
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    assert.ok(!Object.hasOwn(formattedSpan.metrics, APM_TRACING_ENABLED_KEY))
  })

  describe('with DD_TRACE_OTEL_SEMANTICS_ENABLED', () => {
    function formattedHttpSpan () {
      return {
        meta: {
          'span.kind': 'server',
          'http.method': 'GET',
          'http.url': 'http://localhost:8080/u',
          'http.status_code': '200',
          'http.endpoint': '/u',
        },
        metrics: {},
      }
    }

    it('applies the OTel HTTP rename to the exported span', () => {
      spanFormat.returns(formattedHttpSpan())
      const otelConfig = {
        flushMinSpans: 3,
        stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false },
        appsec: {},
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
      }
      const processor = new SpanProcessor(exporter, prioritySampler, otelConfig)
      trace.started = [finishedSpan]
      trace.finished = [finishedSpan]

      processor.process(finishedSpan)

      const exported = exporter.export.firstCall.args[0][0]
      assert.strictEqual(exported.meta['http.request.method'], 'GET')
      assert.strictEqual(exported.metrics['http.response.status_code'], 200)
      assert.ok(!('http.method' in exported.meta))
    })

    it('records span stats from the Datadog tag names, before the export-only rename', () => {
      spanFormat.returns(formattedHttpSpan())
      const otelConfig = {
        flushMinSpans: 3,
        stats: { DD_TRACE_STATS_COMPUTATION_ENABLED: false },
        appsec: {},
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
      }
      const processor = new SpanProcessor(exporter, prioritySampler, otelConfig)
      const statsView = {}
      processor._stats = {
        onSpanFinished: sinon.spy(span => {
          statsView.method = span.meta['http.method']
          statsView.statusCode = span.meta['http.status_code']
          statsView.endpoint = span.meta['http.endpoint']
        }),
      }
      trace.started = [finishedSpan]
      trace.finished = [finishedSpan]

      processor.process(finishedSpan)

      assert.deepStrictEqual(statsView, { method: 'GET', statusCode: '200', endpoint: '/u' })
    })
  })
})
