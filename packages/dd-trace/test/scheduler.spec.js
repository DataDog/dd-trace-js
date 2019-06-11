'use strict'

const EventEmitter = require('eventemitter3')
const proxyquire = require('proxyquire').noCallThru()

describe('Scheduler', () => {
  let Scheduler
  let clock
  let platform

  beforeEach(() => {
    platform = new EventEmitter()

    Scheduler = proxyquire('../src/scheduler', {
      './platform': platform
    })

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

    it('should call the callback when the process exits gracefully', () => {
      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      platform.emit('exit')

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
      const spy = sinon.spy()
      const scheduler = new Scheduler(spy, 5000)

      scheduler.start()
      scheduler.stop()
      platform.emit('exit')

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
