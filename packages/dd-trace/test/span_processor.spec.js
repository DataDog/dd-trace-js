'use strict'

const assert = require('node:assert/strict')

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
  let spanFormat
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
    spanFormat = sinon.stub().returns({ formatted: true })

    sample = sinon.stub()
    SpanSampler = sinon.stub().returns({
      sample
    })

    SpanProcessor = proxyquire('../src/span_processor', {
      './span_format': spanFormat,
      './span_sampler': SpanSampler
    })
    processor = new SpanProcessor(exporter, prioritySampler, config)
  })

  it('should generate sampling priority', () => {
    processor.process(finishedSpan)

    sinon.assert.calledWith(prioritySampler.sample, finishedSpan.context())
  })

  it('should generate sampling priority when sampling manually', () => {
    processor.sample(finishedSpan)

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

    sinon.assert.notCalled(exporter.export)
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
      { formatted: true }
    ])

    expect(trace).to.have.deep.property('started', [activeSpan])
    expect(trace).to.have.deep.property('finished', [])
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
            maxPerSecond: 456
          }
        ]
      }
    }

    const processor = new SpanProcessor(exporter, prioritySampler, config)
    processor.process(finishedSpan)

    sinon.assert.calledWith(SpanSampler, config.sampler)
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
    sinon.assert.notCalled(exporter.export)
  })

  it('should call spanFormat every time a partial flush is triggered', () => {
    config.flushMinSpans = 1
    const processor = new SpanProcessor(exporter, prioritySampler, config)
    trace.started = [activeSpan, finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(activeSpan)

    expect(trace).to.have.deep.property('started', [activeSpan])
    expect(trace).to.have.deep.property('finished', [])
    assert.strictEqual(spanFormat.callCount, 1)
    sinon.assert.calledWith(spanFormat, finishedSpan, true)
  })

  it('should add span tags to first span in a chunk', () => {
    config.flushMinSpans = 2
    config.propagateProcessTags = { enabled: true }
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
        expect(value).to.equal('test')
        foundATag = true
      })
      expect(foundATag).to.be.true
    }

    // The process tags are passed to the exporter and added at the encoder level,
    // not at the span formatting level anymore. The span processor just computes them.
    expect(exporter._processTags).to.equal(processor._processTags)
    
    // Verify spans were formatted without process tag parameters
    expect(spanFormat.getCall(0)).to.have.been.calledWith(finishedSpan)
    expect(spanFormat.getCall(1)).to.have.been.calledWith(finishedSpan)
    expect(spanFormat.getCall(2)).to.have.been.calledWith(finishedSpan)
    expect(spanFormat.getCall(3)).to.have.been.calledWith(finishedSpan)
  })
})
