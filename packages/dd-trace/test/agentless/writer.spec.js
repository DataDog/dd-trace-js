'use strict'

describe('Writer', () => {
  let Writer
  let writer
  let prioritySampler
  let trace
  let span
  let format
  let log
  let tracer
  let scope
  let outputStream

  beforeEach(() => {
    scope = {
      _wipe: sinon.stub()
    }

    tracer = {
      scope: sinon.stub().returns(scope)
    }

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

    format = sinon.stub().withArgs(span).returns({ formatted: true })

    log = {
      error: sinon.spy()
    }

    prioritySampler = {
      update: sinon.stub(),
      sample: sinon.stub()
    }

    outputStream = {
      write: sinon.stub()
    }

    Writer = proxyquire('../src/agentless/writer', {
      '../log': log,
      '../format': format
    })
    writer = new Writer(prioritySampler, outputStream)
  })

  describe('length', () => {
    it('should return the number of traces', () => {
      trace.finished = [span, span]
      trace.started = [span, span]
      writer.append(span)
      writer.append(span)

      expect(writer.length).to.equal(2)
    })
  })

  describe('append', () => {
    it('should append a trace', () => {
      trace.started = [span]
      trace.finished = [span]
      writer.append(span)

      expect(writer._queue).to.deep.equal(['{"formatted":true}'])
    })

    it('should skip traces with unfinished spans', () => {
      trace.started = [span]
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should flush when full', () => {
      trace.started = [span]
      trace.finished = [span]
      writer.append(span)
      writer._size = 255 * 1024
      trace.started = [span]
      trace.finished = [span]
      writer.append(span)

      expect(writer.length).to.equal(1)
    })

    it('should not append if the span was dropped', () => {
      span.context()._traceFlags.sampled = false
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should generate sampling priority', () => {
      writer.append(span)

      expect(prioritySampler.sample).to.have.been.calledWith(span.context())
    })

    it('should erase the trace once finished', () => {
      trace.started = [span]
      trace.finished = [span]

      writer.append(span)

      expect(trace).to.have.deep.property('started', [])
      expect(trace).to.have.deep.property('finished', [])
      expect(span.context()).to.have.deep.property('_tags', {})
      expect(span.context()).to.have.deep.property('_metrics', {})
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()
      expect(outputStream.write).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append(span)
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its traces to the output stream', () => {
      trace.started = [span, span]
      trace.finished = [span, span]
      writer.append(span)
      writer.append(span)
      writer.flush()
      const result = '{"datadog_traces":[{"formatted":true},{"formatted":true}]}'
      expect(outputStream.write).to.have.been.calledWithMatch(result)
    })
  })
})
