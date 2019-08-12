
describe('SpanProcessor', () => {

  let prioritySampler
  let spanProcessor
  let SpanProcessor
  let span
  let trace
  let exporter
  let tracer

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
    SpanProcessor = proxyquire('../src/span_processor', {})
    spanProcessor = new SpanProcessor(exporter, prioritySampler)
  })

  it('should generate sampling priority', () => {
    spanProcessor.process(span)

    expect(prioritySampler.sample).to.have.been.calledWith(span.context())
  })

  it('should erase the trace once finished', () => {
    trace.started = [span]
    trace.finished = [span]

    spanProcessor.process(span)

    expect(trace).to.have.deep.property('started', [])
    expect(trace).to.have.deep.property('finished', [])
    expect(span.context()).to.have.deep.property('_tags', {})
    expect(span.context()).to.have.deep.property('_metrics', {})
  })

  it('should skip traces with unfinished spans', () => {
    trace.started = [span]
    trace.finished = []
    spanProcessor.process(span)

    expect(exporter.export).not.to.have.been.called
  })
  it('should not append if the span was dropped', () => {
    span.context()._traceFlags.sampled = false
    spanProcessor.process(span)

    expect(exporter.export).not.to.have.been.called
  })
})
