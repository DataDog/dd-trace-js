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

  const Exporter = proxyquire('../../../../src/ci-visibility/exporters/agentless', {
    './writer': Writer
  })

  let exporter

  beforeEach(() => {
    sinon.resetHistory()
  })

  describe('when interval is set to a positive number', function () {
    this.timeout(5000)
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
})
