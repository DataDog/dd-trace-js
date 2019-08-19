'use strict'

describe('Exporter', () => {
  let url
  let interval
  let Scheduler
  let scheduler
  let Exporter
  let exporter
  let Writer
  let writer
  let span

  beforeEach(() => {
    url = 'www.example.com'
    interval = 1000
    span = {}
    scheduler = {
      start: sinon.spy(),
      reset: sinon.spy()
    }
    writer = {
      append: sinon.spy(),
      flush: sinon.spy()
    }
    Scheduler = sinon.stub().returns(scheduler)
    Writer = sinon.stub().returns(writer)

    Exporter = proxyquire('../src/exporters/agent', {
      './scheduler': Scheduler,
      './writer': Writer
    })
  })

  describe('when interval is set to a positive number', () => {
    beforeEach(() => {
      exporter = new Exporter({ url, interval })
    })

    it('should schedule flushing after the configured interval', () => {
      writer.length = 0
      exporter = new Exporter({ url, interval })
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
      exporter = new Exporter({ url, interval: 0 })
    })

    it('should flush right away when interval is set to 0', () => {
      exporter.export([span])
      expect(writer.flush).to.have.been.called
    })
  })
})
