'use strict'

describe('LogExporter', () => {
  let Exporter
  let exporter
  let span
  let outputStream

  beforeEach(() => {
    span = { formatted: true }

    outputStream = {
      write: sinon.stub()
    }

    Exporter = proxyquire('../src/exporters/log', {})
    exporter = new Exporter(outputStream)
  })

  describe('export', () => {
    it('should flush its traces to the output stream', () => {
      exporter.export([span, span])
      const result = '{"datadog_traces":[{"formatted":true},{"formatted":true}]}'
      expect(outputStream.write).to.have.been.calledWithMatch(result)
    })

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      const maxSize = 20
      exporter = new Exporter(outputStream, maxSize)
      exporter.export([span, span])
      const result = '{"datadog_traces":[{"formatted":true}]}'
      expect(outputStream.write).to.have.calledTwice
      expect(outputStream.write).to.have.been.calledWithMatch(result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      const maxSize = 5
      exporter = new Exporter(outputStream, maxSize)
      exporter.export([span, span])
      expect(outputStream.write).not.to.have.been.called
    })
  })
})
