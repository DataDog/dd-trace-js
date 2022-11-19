'use strict'

require('../../setup/tap')

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
    it('should flush its traces to the console', () => {
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = '{"traces":[[{"tag":"test"},{"tag":"test"}]]}'
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      //  64kb is the limit for a single log line. We create a span that matches that length exactly.
      const expectedPrefix = '{"traces":[[{"tag":"'
      const expectedSuffix = '"}]]}\n'
      span.tag = new Array(64 * 1024 - expectedPrefix.length - expectedSuffix.length).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = `${expectedPrefix}${span.tag}${expectedSuffix}`
      expect(log).to.have.calledTwice
      expect(log).to.have.been.calledWithMatch(result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      //  64kb is the limit for a single log line. We create a span that exceeds that by 1 byte
      const expectedPrefix = '{"traces":[[{"tag":"'
      const expectedSuffix = '"}]]}\n'
      span.tag = new Array(64 * 1024 - expectedPrefix.length - expectedSuffix.length + 1).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      expect(log).not.to.have.been.called
    })
  })
})
