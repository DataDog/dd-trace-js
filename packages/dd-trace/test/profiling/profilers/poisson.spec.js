'use strict'

require('../../setup/tap')
const assert = require('assert')

const PoissonProcessSamplingFilter = require('../../../src/profiling/profilers/poisson')

describe('PoissonProcessSamplingFilter', () => {
  let nowValue
  const now = () => nowValue

  beforeEach(() => {
    nowValue = 0
  })

  it('should throw if resetInterval < samplingInterval', () => {
    assert.throws(() => new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 50,
      now
    }), RangeError)
  })

  it('should throw if now is not a function', () => {
    assert.throws(() => new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now: 123
    }), (err) => err instanceof TypeError && err.message === 'now must be a function')
  })

  it('should throw if now() returns a non-number', () => {
    const badNow = () => 'not-a-number'
    assert.throws(() => new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now: badNow
    }), (err) => err instanceof TypeError && err.message === 'now() must return a number')
  })

  it('should throw if now() returns a decreasing value', () => {
    let callCount = 0
    const decreasingNow = () => {
      callCount++
      return callCount === 1 ? 100 : 50
    }
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 10,
      resetInterval: 20,
      now: decreasingNow
    })
    const event = { startTime: 0, duration: filter.nextSamplingInstant + 1 }
    assert.throws(() => filter.filter(event), (err) => err instanceof RangeError &&
      err.message === 'now() must return a value greater than or equal to the last returned value')
  })

  it('should allow now() to return the same value as last time', () => {
    let callCount = 0
    const constantNow = () => {
      callCount++
      return 42
    }
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 10,
      resetInterval: 20,
      now: constantNow
    })
    assert.strictEqual(callCount, 1)
    const event = { startTime: 0, duration: Number.POSITIVE_INFINITY }
    // Make sure that filtering events does not throw and calls now() once
    filter.filter(event)
    assert.strictEqual(callCount, 2)
  })

  it('should initialize with correct properties', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    assert.strictEqual(typeof filter.currentSamplingInstant, 'number')
    assert.strictEqual(filter.currentSamplingInstant, 0)
    assert.strictEqual(typeof filter.nextSamplingInstant, 'number')
    assert.ok(filter.nextSamplingInstant > 0)
    assert.strictEqual(filter.samplingInstantCount, 1)
  })

  it('should advance sampling instant when event endTime >= nextSamplingInstant', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const prevNextSamplingInstant = filter.nextSamplingInstant
    const event = {
      startTime: -10,
      duration: prevNextSamplingInstant + 15
    }
    assert.strictEqual(filter.currentSamplingInstant, 0)
    nowValue = prevNextSamplingInstant + 15
    filter.filter(event)
    assert.ok(filter.nextSamplingInstant > prevNextSamplingInstant)
    assert.ok(filter.currentSamplingInstant > 0)
    assert.ok(filter.samplingInstantCount > 1)
  })

  it('should not advance sampling instant if event endTime < nextSamplingInstant', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const prevSamplingInstant = filter.currentSamplingInstant
    const prevNextSamplingInstant = filter.nextSamplingInstant
    const event = { startTime: prevSamplingInstant - 10, duration: 1 }
    filter.filter(event)
    assert.strictEqual(filter.currentSamplingInstant, prevSamplingInstant)
    assert.strictEqual(filter.nextSamplingInstant, prevNextSamplingInstant)
    assert.strictEqual(filter.samplingInstantCount, 1)
  })

  it('should cap endTime to now() if event endTime is in the future', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const prevNextSamplingInstant = filter.nextSamplingInstant
    nowValue = 1000
    const event = { startTime: 0, duration: 1e6 }
    filter.filter(event)
    assert.ok(filter.currentSamplingInstant >= prevNextSamplingInstant)
    assert.strictEqual(typeof filter.nextSamplingInstant, 'number')
    assert.ok(filter.nextSamplingInstant < 500000)
    assert.ok(filter.samplingInstantCount < 10)
  })

  it('should reset nextSamplingInstant if it is too far in the past', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const event = { startTime: 100000, duration: 100 }
    nowValue = event.startTime + event.duration
    filter.filter(event)
    assert.ok(filter.nextSamplingInstant > nowValue)
    assert.ok(filter.samplingInstantCount < 10)
  })

  it('should return true if event.startTime < currentSamplingInstant', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const event = { startTime: filter.currentSamplingInstant - 1, duration: 1 }
    assert.strictEqual(filter.filter(event), true)
  })

  it('should return false if event.startTime >= currentSamplingInstant', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 100,
      resetInterval: 200,
      now
    })
    const event = { startTime: filter.currentSamplingInstant, duration: 1 }
    assert.strictEqual(filter.filter(event), false)
  })

  it('should increment samplingInstantCount on each sampling instant', () => {
    const filter = new PoissonProcessSamplingFilter({
      samplingInterval: 10,
      resetInterval: 100,
      now
    })
    const initialCount = filter.samplingInstantCount
    for (let i = 0; i < 5; i++) {
      nowValue += 20
      const event = { startTime: 0, duration: filter.nextSamplingInstant - 0 }
      filter.filter(event)
    }
    assert.ok(filter.samplingInstantCount > initialCount)
  })
})
