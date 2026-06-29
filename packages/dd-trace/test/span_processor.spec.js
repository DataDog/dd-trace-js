'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

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
  let spanFormat
  let config
  let SpanSampler
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
    spanFormat = sinon.stub().returns({ formatted: true })

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample,
    })

    SpanProcessor = proxyquire('../src/span_processor', {
      './span_format': spanFormat,
      './span_sampler': SpanSampler,
    })
    processor = new SpanProcessor(exporter, prioritySampler, config)
  })

  it('should generate sampling priority', () => {
    processor.process(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should generate sampling priority when sampling manually', () => {
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
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan]
    processor.process(finishedSpan)

    sinon.assert.calledWith(exporter.export, [
      { formatted: true },
      { formatted: true },
      { formatted: true },
    ])

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
