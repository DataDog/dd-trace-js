'use strict'

const Scheduler = require('../../../src/appsec/remote_config/scheduler')

describe('Scheduler', () => {
  let clock
  let stub
  let scheduler

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    stub = sinon.stub()
    scheduler = new Scheduler(stub, 5000)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('func', () => {
    it('should not run when already running', () => {
      let cb
      stub.callsFake((_cb) => { cb = _cb })

      scheduler.func()
      expect(stub).to.have.been.calledOnce

      scheduler.func()
      expect(stub).to.have.been.calledOnce

      cb()

      scheduler.func()
      expect(stub).to.have.been.calledTwice
    })
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

    it('should call the callback at the specified interval', () => {
      stub.yieldsRight()

      scheduler.start()
      clock.tick(1)

      expect(stub).to.have.been.calledOnce

      clock.tick(5000)

      expect(stub).to.have.been.calledTwice

      clock.tick(5000)

      expect(stub).to.have.been.calledThrice
    })
  })

  describe('stop', () => {
    it('should stop calling the callback at the specified interval', () => {
      stub.yieldsRight()

      scheduler.start()
      scheduler.stop()
      clock.tick(5000)

      expect(stub).to.have.been.calledOnce
    })
  })
})
