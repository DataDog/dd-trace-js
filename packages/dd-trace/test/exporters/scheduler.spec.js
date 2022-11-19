'use strict'

require('../setup/core')

describe('Scheduler', () => {
  let Scheduler
  let clock
  let once
  let removeListener

  beforeEach(() => {
    Scheduler = require('../../src/exporters/scheduler')

    clock = sinon.useFakeTimers()
    once = process.once
    removeListener = process.removeListener
  })

  afterEach(() => {
    clock.restore()
    process.once = once
    process.removeListener = removeListener
  })

  describe('start', () => {
    it('should call the callback at the specified interval', () => {
      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      clock.tick(5000)

      expect(spy).to.have.been.calledOnce

      clock.tick(5000)

      expect(spy).to.have.been.calledTwice
    })

    it('should call the callback when the process exits gracefully', () => {
      process.once = sinon.spy()

      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      process.once.withArgs('beforeExit').yield()

      expect(spy).to.have.been.called
    })
  })

  describe('stop', () => {
    it('should stop calling the callback at the specified interval', () => {
      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      scheduler.stop()
      clock.tick(5000)

      expect(spy).to.not.have.been.called
    })

    it('should stop calling the callback when the process exits gracefully', () => {
      process.once = sinon.spy()
      process.removeListener = sinon.spy()

      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      scheduler.stop()

      expect(process.removeListener).to.have.been.calledWith('beforeExit', process.once.firstCall.args[1])
    })
  })

  describe('reset', () => {
    it('should reset the internal clock', () => {
      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      clock.tick(4000)
      scheduler.reset()
      clock.tick(6000)

      expect(spy).to.have.been.calledOnce
    })
  })
})
