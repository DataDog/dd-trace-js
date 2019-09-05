'use strict'

describe('LogExporter', () => {
  let Exporter
  let exporter
  let span
  let log

  beforeEach(() => {
    span = { tag: 'test' }

    Exporter = proxyquire('../src/exporters/log', {})
    exporter = new Exporter()
  })

  describe('export', () => {
    it('should flsh its traces to the console', () => {
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = '{"traces":[[{"tag":"test"},{"tag":"test"}]]}'
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      span.tag = new Array(200000).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = `{"traces":[[{"tag":"${span.tag}"}]]}`
      expect(log).to.have.calledTwice
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      span.tag = new Array(300000).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      expect(log).not.to.have.been.called
    })
  })
})
