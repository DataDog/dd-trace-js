'use strict'
const proxyquire = require('proxyquire')

describe('CI Visibility Exporter', () => {
  const url = 'www.example.com'
  const flushInterval = 1000
  const writer = {
    append: sinon.spy(),
    flush: sinon.spy(),
    appendCoverage: sinon.spy(),
    flushCoverage: sinon.spy()
  }
  const Writer = sinon.stub().returns(writer)

  const Exporter = proxyquire('../../../../src/ci-visibility/exporters/agentless', {
    './writer': Writer
  })

  let exporter

  beforeEach(() => {
    sinon.resetHistory()
  })

  describe('when interval is set to a positive number', function () {
    this.timeout(5000)
    it('should flush after the configured interval', (done) => {
      exporter = new Exporter({ url, flushInterval })
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        done()
      }, flushInterval)
    })
  })

  describe('when export is called', () => {
    it('should append a span', () => {
      const span = {}
      exporter = new Exporter({ url, flushInterval })
      exporter.export([span])

      expect(writer.append).to.have.been.calledWith([span])
    })
  })

  describe('when interval is set to 0', () => {
    it('should flush right away', () => {
      const span = {}
      exporter = new Exporter({ url, flushInterval: 0 })
      exporter.export([span])
      expect(writer.flush).to.have.been.called
    })
  })

  describe('when ITR is enabled', () => {
    it('should append a code coverage payload when exportCoverage is called', () => {
      const testSpan = {
        context: () => ({ _traceId: '1', _spanId: '2' })
      }
      const payload = { testSpan, coverageFiles: ['file.js'] }

      exporter = new Exporter({ url, flushInterval: 0, isITREnabled: true })

      exporter.exportCoverage(payload)
      expect(writer.appendCoverage).to.have.been.calledWith({
        traceId: '1',
        spanId: '2',
        files: ['file.js']
      })
      expect(writer.flushCoverage).to.have.been.called
    })
    it('should flush after the configured flush interval', function (done) {
      this.timeout(5000)
      exporter = new Exporter({ url, flushInterval, isITREnabled: true })

      const testSpan = {
        context: () => ({ _traceId: '1', _spanId: '2' })
      }
      const payload = { testSpan, coverageFiles: ['file.js'] }

      exporter.exportCoverage(payload)

      setTimeout(() => {
        expect(writer.flushCoverage).to.have.been.called
        done()
      }, flushInterval)
      expect(writer.appendCoverage).to.have.been.called
    })
  })
})
