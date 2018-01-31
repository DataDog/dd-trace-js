'use strict'

describe('Scheduler', () => {
  let Scheduler
  let clock

  beforeEach(() => {
    Scheduler = require('../src/scheduler')
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
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
