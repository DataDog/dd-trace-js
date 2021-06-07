'use strict'

const URL = require('url').URL

describe('Exporter', () => {
  let url
  let flushInterval
  let Scheduler
  let scheduler
  let Exporter
  let exporter
  let Writer
  let writer
  let prioritySampler
  // let span

  beforeEach(() => {
    url = 'www.example.com'
    flushInterval = 1000
    // span = {}
    scheduler = {
      start: sinon.spy(),
      reset: sinon.spy()
    }
    writer = {
      append: sinon.spy(),
      flush: sinon.spy(),
      setUrl: sinon.spy()
    }
    prioritySampler = {}
    Scheduler = sinon.stub().returns(scheduler)
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../src/exporters/agent', {
      './scheduler': Scheduler,
      './writer': Writer
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
    })

    it('should schedule flushing after the configured interval', () => {
      writer.length = 0
      exporter = new Exporter({ url, flushInterval }, prioritySampler)
      Scheduler.firstCall.args[0]()

      expect(scheduler.start).to.have.been.called
      expect(writer.flush).to.have.been.called
    })

    // describe('export', () => {
    //   beforeEach(() => {
    //     span = {}
    //   })

    //   it('should export a span', () => {
    //     writer.length = 0
    //     exporter.export([span])

    //     expect(writer.append).to.have.been.calledWith([span])
    //   })
    // })
  })

  describe('when interval is set to 0', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, flushInterval: 0 })
    })

    // it('should flush right away when interval is set to 0', () => {
    //   exporter.export([span])
    //   expect(writer.flush).to.have.been.called
    // })
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
