'use strict'

describe('LogExporter', () => {
  let Exporter
  let exporter
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

    outputStream = {
      write: sinon.stub()
    }

    Exporter = proxyquire('../src/agentless/exporter', {
      '../log': log,
      '../format': format
    })
    exporter = new Exporter(outputStream)
  })

  describe('export', () => {
    it('should flush its traces to the output stream', () => {
      trace.started = [span, span]
      trace.finished = [span, span]
      exporter.export(span)
      const result = '{"datadog_traces":[{"formatted":true},{"formatted":true}]}'
      expect(outputStream.write).to.have.been.calledWithMatch(result)
    })
  })
})
