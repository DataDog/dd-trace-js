'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha

require('./setup/core')

const Histogram = require('../src/histogram')

describe('Histogram', () => {
  let histogram

  beforeEach(() => {
    histogram = new Histogram()
  })

  it('should record values', () => {
    for (let i = 1; i < 100; i++) {
      histogram.record(i)
    }

    const median = histogram.median
    const p50 = histogram.percentile(50)
    const p95 = histogram.percentile(95)

    assert.strictEqual(histogram.min, 1)
    assert.strictEqual(histogram.max, 99)
    assert.strictEqual(histogram.sum, 4950)
    assert.strictEqual(histogram.avg, 50)
    assert.ok(typeof histogram.median === 'number')
    assert.strictEqual(histogram.count, 99)
    assert.ok(typeof histogram.p95 === 'number')
    assert.ok(median >= 49)
    assert.ok(median <= 51)
    assert.ok(p50 >= 49)
    assert.ok(p50 <= 51)
    assert.ok(p95 >= 94)
    assert.ok(p95 <= 96)
  })

  it('should reset all stats', () => {
    histogram.record(1)
    histogram.record(2)
    histogram.record(3)

    histogram.reset()

    assert.strictEqual(histogram.min, 0)
    assert.strictEqual(histogram.max, 0)
    assert.strictEqual(histogram.sum, 0)
    assert.strictEqual(histogram.avg, 0)
    assert.strictEqual(histogram.median, 0)
    assert.strictEqual(histogram.count, 0)
    assert.strictEqual(histogram.p95, 0)
    assert.strictEqual(histogram.percentile(50), 0)
  })
})
