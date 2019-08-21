'use strict'

describe('LogExporter', () => {
  let Exporter
  let exporter
  let span
  let log

  beforeEach(() => {
    span = { tag: 'test' }

    log = sinon.stub(console, 'log')

    Exporter = proxyquire('../src/exporters/log', {})
    exporter = new Exporter()
  })

  afterEach(() => {
    log.restore()
  })

  describe('export', () => {
    it('should flush its traces to the console', () => {
      exporter.export([span, span])
      const result = '{"datadog_traces":[{"tag":"test"},{"tag":"test"}]}'
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      span.tag = new Array(200000).fill('a').join('')
      exporter.export([span, span])
      const result = `{"datadog_traces":[{"tag":"${span.tag}"}]}`
      expect(log).to.have.calledTwice
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      span.tag = new Array(300000).fill('a').join('')
      exporter.export([span, span])
      expect(log).not.to.have.been.called
    })
  })
})
