'use strict'

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
  let span
  let config

  beforeEach(() => {
    url = 'www.example.com'
    flushInterval = 1000
    span = {}
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
    config = proxyquire('../src/config', {})

    Exporter = proxyquire('../src/exporters/agent', {
      './scheduler': Scheduler,
      './writer': Writer,
      '../../config': config
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      config.configure({ url, flushInterval })
      exporter = new Exporter(prioritySampler)
    })

    it('should schedule flushing after the configured interval', () => {
      writer.length = 0
      config.configure({ url, flushInterval })
      exporter = new Exporter(prioritySampler)
      Scheduler.firstCall.args[0]()

      expect(scheduler.start).to.have.been.called
      expect(writer.flush).to.have.been.called
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
      config.configure({ url, flushInterval: 0 })
      exporter = new Exporter()
    })

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      expect(writer.flush).to.have.been.called
    })
  })
})
