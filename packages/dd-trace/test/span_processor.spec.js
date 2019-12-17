
describe('SpanProcessor', () => {
  let prioritySampler
  let processor
  let SpanProcessor
  let span
  let trace
  let exporter
  let tracer
  let format

  beforeEach(() => {
    tracer = {}
    trace = {
      started: [],
      finished: []
    }
    span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {},
        _tags: {},
        _traceFlags: {}
      })
    }

    exporter = {
      export: sinon.stub()
    }
    prioritySampler = {
      sample: sinon.stub()
    }
    format = sinon.stub().returns([span])

    SpanProcessor = proxyquire('../src/span_processor', {
      './format': format
    })
    processor = new SpanProcessor(exporter, prioritySampler)
  })

  it('should generate sampling priority', () => {
    processor.process(span)

    expect(prioritySampler.sample).to.have.been.calledWith(span.context())
  })

  it('should erase the trace once finished', () => {
    trace.started = [span]
    trace.finished = [span]

    processor.process(span)

    expect(trace).to.have.deep.property('started', [])
    expect(trace).to.have.deep.property('finished', [])
    expect(span.context()).to.have.deep.property('_tags', {})
  })

  it('should skip traces with unfinished spans', () => {
    trace.started = [span]
    trace.finished = []
    processor.process(span)

    expect(exporter.export).not.to.have.been.called
  })
  it('should not append if the span was dropped', () => {
    span.context()._traceFlags.sampled = false
    processor.process(span)

    expect(exporter.export).not.to.have.been.called
  })
})
