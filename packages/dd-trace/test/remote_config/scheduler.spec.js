'use strict'
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

const Scheduler = require('../../src/remote_config/scheduler')

const INTERVAL = 5e3

describe('Scheduler', () => {
  let clock
  let stub
  let scheduler

  beforeEach(() => {
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
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

      sinon.assert.calledOnce(stub)
    })

    it('should call the callback once the async operation is done and a delay has passed', () => {
      let cb = () => { throw new Error('Should not be called') }
      stub.callsFake((_cb) => { cb = _cb })

      scheduler.start()
      clock.tick(1)
      sinon.assert.calledOnce(stub)

      clock.tick(INTERVAL)
      sinon.assert.calledOnce(stub)

      cb()
      clock.tick(1)
      sinon.assert.calledOnce(stub)

      clock.tick(INTERVAL)
      sinon.assert.calledTwice(stub)

      cb()
      clock.tick(INTERVAL)
      sinon.assert.calledThrice(stub)
    })
  })

  describe('stop', () => {
    it('should stop calling the callback at the specified interval', () => {
      stub.yieldsRight()

      scheduler.start()
      clock.tick(1)

      scheduler.stop()
      clock.tick(INTERVAL)

      sinon.assert.calledOnce(stub)
    })
  })
})
