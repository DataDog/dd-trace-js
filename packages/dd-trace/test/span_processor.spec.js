'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
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
  let format
  let config
  let SpanSampler
  let sample

  beforeEach(() => {
    tracer = {}
    trace = {
      started: [],
      finished: []
    }

    const span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {},
        _tags: {}
      })
    }

    activeSpan = { ...span }
    finishedSpan = { ...span, _duration: 100 }

    exporter = {
      export: sinon.stub()
    }
    prioritySampler = {
      sample: sinon.stub()
    }
    config = {
      flushMinSpans: 3,
      stats: {
        enabled: false
      }
    }
    format = sinon.stub().returns({ formatted: true })

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample
    })

    SpanProcessor = proxyquire('../src/span_processor', {
      './format': format,
      './span_sampler': SpanSampler
    })
    processor = new SpanProcessor(exporter, prioritySampler, config)
  })

  it('should generate sampling priority', () => {
    processor.process(finishedSpan)

    expect(prioritySampler.sample).to.have.been.calledWith(finishedSpan.context())
  })

  it('should erase the trace once finished', () => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    expect(trace).to.have.deep.property('started', [])
    expect(trace).to.have.deep.property('finished', [])
    expect(finishedSpan.context()).to.have.deep.property('_tags', {})
  })

  it('should skip traces with unfinished spans', () => {
    trace.started = [activeSpan, finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    expect(exporter.export).not.to.have.been.called
  })

  it('should skip unrecorded traces', () => {
    trace.record = false
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(activeSpan)

    expect(exporter.export).not.to.have.been.called
  })

  it('should export a partial trace with span count above configured threshold', () => {
    trace.started = [activeSpan, finishedSpan, finishedSpan, finishedSpan]
    trace.finished = [finishedSpan, finishedSpan, finishedSpan]
    processor.process(finishedSpan)

    expect(exporter.export).to.have.been.calledWith([
      { formatted: true },
      { formatted: true },
      { formatted: true }
    ])

    expect(trace).to.have.deep.property('started', [activeSpan])
    expect(trace).to.have.deep.property('finished', [])
  })

  it('should configure span sampler conrrectly', () => {
    const config = {
      stats: { enabled: false },
      sampler: {
        sampleRate: 0,
        spanSamplingRules: [
          {
            service: 'foo',
            name: 'bar',
            sampleRate: 123,
            maxPerSecond: 456
          }
        ]
      }
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config)
    processor.process(finishedSpan)

    expect(SpanSampler).to.have.been.calledWith(config.sampler)
  })

  it('should erase the trace and stop execution when tracing=false', () => {
    const config = {
      tracing: false,
      stats: {
        enabled: false
      }
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [activeSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    expect(trace).to.have.deep.property('started', [])
    expect(trace).to.have.deep.property('finished', [])
    expect(finishedSpan.context()).to.have.deep.property('_tags', {})
    expect(exporter.export).not.to.have.been.called
  })
})
