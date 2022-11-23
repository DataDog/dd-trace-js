'use strict'

require('../../../../dd-trace/test/setup/tap')

const Scheduler = require('../../../src/appsec/remote_config/scheduler')

const INTERVAL = 5e3

describe('Scheduler', () => {
  let clock
  let stub
  let scheduler

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    stub = sinon.stub()
    scheduler = new Scheduler(stub, INTERVAL)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('start', () => {
    it('should not start when already started', () => {
      stub.yieldsRight()

      scheduler.start()

      scheduler.start()
      clock.tick(1)

      scheduler.start()
      clock.tick(1)

      expect(stub).to.have.been.calledOnce
    })

    it('should call the callback once the async operation is done and a delay has passed', () => {
      let cb
      stub.callsFake((_cb) => { cb = _cb })

      scheduler.start()
      clock.tick(1)
      expect(stub).to.have.been.calledOnce

      clock.tick(INTERVAL)
      expect(stub).to.have.been.calledOnce

      cb()
      clock.tick(1)
      expect(stub).to.have.been.calledOnce

      clock.tick(INTERVAL)
      expect(stub).to.have.been.calledTwice

      cb()
      clock.tick(INTERVAL)
      expect(stub).to.have.been.calledThrice
    })
  })

  describe('stop', () => {
    it('should stop calling the callback at the specified interval', () => {
      stub.yieldsRight()

      scheduler.start()
      clock.tick(1)

      scheduler.stop()
      clock.tick(INTERVAL)

      expect(stub).to.have.been.calledOnce
    })
  })
})
