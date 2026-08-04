'use strict'

const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const { describe, it } = require('mocha')

const mapWithConcurrency = require('./concurrency')

describe('mapWithConcurrency', () => {
  it('resolves to an empty array for no items', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, () => assert.fail('should not run')), [])
  })

  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms, index) => {
      await delay(ms)
      return index
    })
    assert.deepEqual(results, [0, 1, 2])
  })

  it('runs every item exactly once', async () => {
    const seen = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, item => {
      seen.push(item)
    })
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await delay(5)
      active -= 1
    })
    assert.equal(peak, 3)
  })

  it('rejects with the first error and stops scheduling new work', async () => {
    let started = 0
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async item => {
        started += 1
        if (item === 2) throw new Error('boom')
        await delay(1)
      }),
      /boom/
    )
    // With concurrency 1 the failure on item 2 prevents items 3-6 from starting.
    assert.equal(started, 2)
  })

  it('stops in-flight workers from taking new items after a failure with concurrency > 1', async () => {
    const started = []
    await assert.rejects(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async item => {
        started.push(item)
        if (item === 0) throw new Error('boom')
        await delay(10)
      }),
      /boom/
    )
    // Give any worker that ignored the failure flag time to schedule later items; none should.
    await delay(50)
    assert.deepEqual(started.sort((a, b) => a - b), [0, 1])
  })

  it('rejects for an invalid concurrency', async () => {
    await assert.rejects(mapWithConcurrency([1], 0, () => {}), RangeError)
  })
})
