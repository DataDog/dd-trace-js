'use strict'

const URL = require('url').URL

describe('Exporter', () => {
  let url
  let flushInterval
  let Exporter
  let exporter
  let Writer
  let writer
  let prioritySampler
  let span

  beforeEach(() => {
    url = 'www.example.com'
    flushInterval = 1000
    span = {}
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }
    prioritySampler = {}
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../src/exporters/agent', {
      './writer': Writer
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    it('should not flush if export has not been called', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      setTimeout(() => {
        expect(writer.flush).not.to.have.been.called
        done()
      }, flushInterval + 100)
    })

    it('should flush after the configured interval if a payload has been exported', (done) => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      exporter.export([{}])
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        done()
      }, flushInterval + 100)
    })

    describe('export', () => {
      beforeEach(() => {
        span = {}
      })

      it('should export a span', () => {
        writer.length = 0
        exporter.export([span])

        expect(writer.append).to.have.been.calledWith([span])
      })
    })
  })

  describe('when interval is set to 0', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval: 0 })
    })

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      expect(writer.flush).to.have.been.called
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      exporter = new Exporter({ url })
    })
    it('should set the URL on self and writer', () => {
      exporter.setUrl('http://example2.com')
      const url = new URL('http://example2.com')
      expect(exporter._url).to.deep.equal(url)
      expect(writer.setUrl).to.have.been.calledWith(url)
    })
  })
})
