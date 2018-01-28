'use strict'

describe('Recorder', () => {
  let Scheduler
  let scheduler
  let Recorder
  let tracer
  let Writer
  let writer
  let recorder

  beforeEach(() => {
    tracer = {
      _flushDelay: 1000,
      _bufferSize: 2
    }
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
    recorder = new Recorder(tracer)
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

    it('should flush if the buffer size is reached', () => {
      writer.length = 2
      recorder.record(trace)

      expect(writer.flush).to.have.been.called
    })

    it('should reset the scheduler if the buffer size is reached', () => {
      writer.length = 2
      recorder.record(trace)

      expect(scheduler.reset).to.have.been.called
    })

    it('should schedule flushing after the configured interval', () => {
      writer.length = 0

      recorder.record(trace)
      Scheduler.firstCall.args[0]()

      expect(scheduler.start).to.have.been.called
      expect(writer.flush).to.have.been.called
    })

    it('should not start multiple schedulers', () => {
      writer.length = 0

      recorder.record(trace)
      recorder.record(trace)

      expect(scheduler.start).to.have.been.calledOnce
    })
  })
})
