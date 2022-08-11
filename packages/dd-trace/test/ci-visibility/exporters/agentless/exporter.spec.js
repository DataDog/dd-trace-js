'use strict'
const proxyquire = require('proxyquire')

describe('CI Visibility Exporter', () => {
  const url = 'www.example.com'
  const flushInterval = 1000
  const writer = {
    append: sinon.spy(),
    flush: sinon.spy()
  }
  const Writer = sinon.stub().returns(writer)

  const coverageWriter = {
    append: sinon.spy(),
    flush: sinon.spy()
  }
  const CoverageWriter = sinon.stub().returns(coverageWriter)

  const Exporter = proxyquire('../../../../src/ci-visibility/exporters/agentless', {
    './writer': Writer,
    './coverage-writer': CoverageWriter
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
    it('should append a code coverage payload when exportCodeverage is called', () => {
      const span = {}
      const payload = { span, coverage: ['file.js'] }

      exporter = new Exporter({ url, flushInterval: 0, isITREnabled: true })

      exporter.exportCoverage(payload)
      expect(coverageWriter.append).to.have.been.called
    })
    it('should flush after the configured flush interval', function (done) {
      this.timeout(5000)
      exporter = new Exporter({ url, flushInterval, isITREnabled: true })
      setTimeout(() => {
        expect(coverageWriter.flush).to.have.been.called
        done()
      }, flushInterval)
    })
  })
})
