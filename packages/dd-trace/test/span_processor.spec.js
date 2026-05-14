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

    SpanProcessor = proxyquire('../src/span_processor', {
      './span_sampler': SpanSampler,
      './native': { OpCode: fakeOpCode },
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

    sinon.assert.calledWith(SpanSampler, config.sampler)
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
  })
})
