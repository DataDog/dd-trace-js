'use strict'

describe('Recorder', () => {
  let Scheduler
  let scheduler
  let Recorder
  let Writer
  let writer
  let recorder

  beforeEach(() => {
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
    Recorder = proxyquire('../src/recorder', {
      './scheduler': Scheduler,
      './writer': Writer
    })
    recorder = new Recorder('http://test', 1000, 2)
  })

  describe('init', () => {
    it('should schedule flushing after the configured interval', () => {
      writer.length = 0

      recorder.init()
      Scheduler.firstCall.args[0]()

      expect(scheduler.start).to.have.been.called
      expect(writer.flush).to.have.been.called
    })
  })

  describe('record', () => {
    let trace

    beforeEach(() => {
      trace = {}
    })

    it('should record traces', () => {
      writer.length = 0
      recorder.record(trace)

      expect(writer.append).to.have.been.calledWith(trace)
    })
  })
})
