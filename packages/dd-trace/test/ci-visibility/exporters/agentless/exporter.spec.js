'use strict'

require('../../../setup/core')

const proxyquire = require('proxyquire')

describe('CI Visibility Exporter', () => {
  const url = new URL('http://www.example.com')
  const flushInterval = 1000
  let writer, Writer, coverageWriter, CoverageWriter, Exporter, exporter

  beforeEach(() => {
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }
    Writer = sinon.stub().returns(writer)

    coverageWriter = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }

    CoverageWriter = sinon.stub().returns(coverageWriter)

    Exporter = proxyquire('../../../../src/ci-visibility/exporters/agentless', {
      './writer': Writer,
      './coverage-writer': CoverageWriter
    })
  })

  describe('when interval is set to a positive number', function () {
    it('should not flush if export has not been called', (done) => {
      exporter = new Exporter({ url, flushInterval })
      setTimeout(() => {
        expect(writer.flush).not.to.have.been.called
        done()
      }, flushInterval)
    })

    it('should flush after the configured interval if a payload has been exported', (done) => {
      exporter = new Exporter({ url, flushInterval })
      exporter.export([{}])
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        done()
      }, flushInterval)
      expect(writer.flush).not.to.have.been.called
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
      const span = {
        context: () => ({ _traceId: '1', _spanId: '2' })
      }
      const payload = { span, coverageFiles: ['file.js'] }

      exporter = new Exporter({ url, flushInterval: 0, isIntelligentTestRunnerEnabled: true })

      exporter.exportCoverage(payload)
      expect(coverageWriter.append).to.have.been.calledWith({
        traceId: '1',
        spanId: '2',
        files: ['file.js']
      })
      expect(coverageWriter.flush).to.have.been.called
    })
    it('should flush after the configured flush interval', function (done) {
      exporter = new Exporter({ url, flushInterval, isIntelligentTestRunnerEnabled: true })

      const span = {
        context: () => ({ _traceId: '1', _spanId: '2' })
      }
      const payload = { span, coverageFiles: ['file.js'] }

      exporter.exportCoverage(payload)

      setTimeout(() => {
        expect(coverageWriter.flush).to.have.been.called
        done()
      }, flushInterval)
      expect(coverageWriter.append).to.have.been.called
      expect(coverageWriter.flush).not.to.have.been.called
    })
  })

  describe('url', () => {
    it('sets the default if URL param is not specified', () => {
      const site = 'd4tad0g.com'
      exporter = new Exporter({ site })
      expect(exporter._url.href).to.equal(`https://citestcycle-intake.${site}/`)
      expect(exporter._coverageUrl.href).to.equal(`https://event-platform-intake.${site}/`)
    })
    it('should set the input URL', () => {
      exporter = new Exporter({ url })
      expect(exporter._url).to.deep.equal(url)
      expect(exporter._coverageUrl).to.deep.equal(url)
    })
    describe('setUrl', () => {
      it('should update the URL on self and writer', () => {
        exporter = new Exporter({ url })
        const newUrl = new URL('http://www.real.com')
        exporter.setUrl(newUrl)
        expect(exporter._url).to.deep.equal(newUrl)
        expect(exporter._coverageUrl).to.deep.equal(newUrl)
        expect(writer.setUrl).to.have.been.calledWith(newUrl)
        expect(coverageWriter.setUrl).to.have.been.calledWith(newUrl)
      })
    })
  })
})
