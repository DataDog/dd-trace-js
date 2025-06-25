'use strict'

const t = require('tap')
require('./setup/core')

t.test('SpanProcessor', t => {
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

  t.beforeEach(() => {
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

  t.test('should generate sampling priority', t => {
    processor.process(finishedSpan)

    expect(prioritySampler.sample).to.have.been.calledWith(finishedSpan.context())
    t.end()
  })

  t.test('should erase the trace once finished', t => {
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]

    processor.process(finishedSpan)

    expect(trace).to.have.deep.property('started', [])
    expect(trace).to.have.deep.property('finished', [])
    expect(finishedSpan.context()).to.have.deep.property('_tags', {})
    t.end()
  })

  t.test('should skip traces with unfinished spans', t => {
    trace.started = [activeSpan, finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(finishedSpan)

    expect(exporter.export).not.to.have.been.called
    t.end()
  })

  t.test('should skip unrecorded traces', t => {
    trace.record = false
    trace.started = [finishedSpan]
    trace.finished = [finishedSpan]
    processor.process(activeSpan)

    expect(exporter.export).not.to.have.been.called
    t.end()
  })

  t.test('should export a partial trace with span count above configured threshold', t => {
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
    t.end()
  })

  t.test('should configure span sampler conrrectly', t => {
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
    t.end()
  })

  t.test('should erase the trace and stop execution when tracing=false', t => {
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
    t.end()
  })
  t.end()
})
