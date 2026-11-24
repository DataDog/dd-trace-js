'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const TelemetryDeliveryTracker = require('../src/serverless/telemetry-delivery-tracker')

describe('bounded telemetry delivery waits', () => {
  let clock
  beforeEach(() => { clock = sinon.useFakeTimers() })
  afterEach(() => sinon.restore())

  it('completes idle waits synchronously without a timeout', () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    const done = sinon.spy()
    tracker.waitForIdle(done)
    sinon.assert.calledOnce(done)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('joins concurrent waits and includes deliveries started while waiting', () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    const complete = []
    const first = sinon.spy()
    const second = sinon.spy()
    tracker.track(done => complete.push(done))
    tracker.waitForIdle(first)
    tracker.waitForIdle(second)
    assert.strictEqual(clock.countTimers(), 1)
    tracker.track(done => complete.push(done))
    complete[0]()
    sinon.assert.notCalled(first)
    sinon.assert.notCalled(second)
    complete[1]()
    sinon.assert.calledOnce(first)
    sinon.assert.calledOnce(second)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('starts the deadline at the first wait rather than the first delivery', async () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    tracker.track(() => {})
    await clock.tickAsync(1000)
    const done = sinon.spy()
    tracker.waitForIdle(done)
    await clock.tickAsync(999)
    sinon.assert.notCalled(done)
    await clock.tickAsync(1)
    sinon.assert.calledOnce(done)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('ignores abandoned callbacks after timeout and allows a new wait', async () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    let completeOld, completeNew
    const first = sinon.spy()
    const second = sinon.spy()
    tracker.track(done => { completeOld = done })
    tracker.waitForIdle(first)
    await clock.tickAsync(1000)
    sinon.assert.calledOnce(first)
    tracker.track(done => { completeNew = done })
    tracker.waitForIdle(second)
    completeOld()
    sinon.assert.notCalled(second)
    completeNew()
    sinon.assert.calledOnce(second)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('cleans up a synchronous delivery failure before rethrowing', () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    const error = new Error('send failed')
    assert.throws(() => tracker.track(() => { throw error }), failure => failure === error)
    const done = sinon.spy()
    tracker.waitForIdle(done)
    sinon.assert.calledOnce(done)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('clears completed wait state before invoking callbacks that start another wait', async () => {
    const tracker = new TelemetryDeliveryTracker(1000)
    let completeFirst, completeSecond
    const second = sinon.spy()
    tracker.track(done => { completeFirst = done })
    tracker.waitForIdle(() => {
      tracker.track(done => { completeSecond = done })
      tracker.waitForIdle(second)
    })
    completeFirst()
    assert.strictEqual(clock.countTimers(), 1)
    completeSecond()
    sinon.assert.calledOnce(second)
    assert.strictEqual(clock.countTimers(), 0)
  })
})
