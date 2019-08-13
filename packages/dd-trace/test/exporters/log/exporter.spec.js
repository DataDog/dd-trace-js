'use strict'

describe('LogExporter', () => {
  let Exporter
  let exporter
  let trace
  let span
  let format
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

    outputStream = {
      write: sinon.stub()
    }

    Exporter = proxyquire('../src/exporters/log/exporter', {
      '../../format': format
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

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      const maxSize = 20
      exporter = new Exporter(outputStream, maxSize)
      trace.started = [span, span]
      trace.finished = [span, span]
      exporter.export(span)
      const result = '{"datadog_traces":[{"formatted":true}]}'
      expect(outputStream.write).to.have.calledTwice
      expect(outputStream.write).to.have.been.calledWithMatch(result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      const maxSize = 5
      exporter = new Exporter(outputStream, maxSize)
      trace.started = [span, span]
      trace.finished = [span, span]
      exporter.export(span)
      expect(outputStream.write).not.to.have.been.called
    })
  })
})
