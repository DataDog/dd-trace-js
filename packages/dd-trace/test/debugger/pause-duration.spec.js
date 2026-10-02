'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/mocha')

const { MAX_MS, MIN_MS, PauseDurationHistogram } = require('../../src/debugger/pause-duration')

describe('debugger/pause-duration', () => {
  /** @type {PauseDurationHistogram} */
  let histogram

  beforeEach(() => {
    histogram = new PauseDurationHistogram(PauseDurationHistogram.createBuffer())
  })

  /**
   * @param {PauseDurationHistogram} [instance]
   * @returns {[durationMs: number, count: number][]}
   */
  function drain (instance = histogram) {
    const reported = []
    instance.drain((durationMs, count) => reported.push([durationMs, count]))
    return reported
  }

  it('should report nothing when no pause was recorded', () => {
    assert.deepStrictEqual(drain(), [])
  })

  it('should report a duration within the documented accuracy', () => {
    histogram.record(2.5)

    const [[durationMs, count]] = drain()
    assert.strictEqual(count, 1)
    assert.ok(Math.abs(durationMs - 2.5) / 2.5 < 0.005, `Expected ${durationMs} to be within 0.5% of 2.5`)
  })

  it('should keep every sample within 0.5% across the supported range', () => {
    // Deliberately includes values that fall on and just inside bucket boundaries
    for (const durationMs of [MIN_MS, 0.011, 0.5, 1, 1.7, 2, 99.999, 100, 1000, 60_000, MAX_MS / 1.01]) {
      const isolated = new PauseDurationHistogram(PauseDurationHistogram.createBuffer())
      isolated.record(durationMs)

      const reported = drain(isolated)
      assert.strictEqual(reported.length, 1, `Expected one bucket for ${durationMs}`)
      const [[reportedMs, count]] = reported
      assert.strictEqual(count, 1)
      const error = Math.abs(reportedMs - durationMs) / durationMs
      assert.ok(error < 0.005, `Expected ${reportedMs} to be within 0.5% of ${durationMs}, was off by ${error}`)
    }
  })

  it('should accumulate pauses that share a bucket into a single report', () => {
    histogram.record(2.5)
    histogram.record(2.5)
    histogram.record(2.5)

    const [[durationMs, count]] = drain()
    assert.strictEqual(count, 3)
    assert.ok(Math.abs(durationMs - 2.5) / 2.5 < 0.005)
  })

  it('should report each distinct bucket separately and in ascending order', () => {
    histogram.record(100)
    histogram.record(1)
    histogram.record(10)

    const reported = drain()
    assert.strictEqual(reported.length, 3)
    assert.deepStrictEqual(reported.map(([, count]) => count), [1, 1, 1])
    const [one, ten, hundred] = reported.map(([durationMs]) => durationMs)
    assert.ok(Math.abs(one - 1) / 1 < 0.005, `Expected ${one} to be within 0.5% of 1`)
    assert.ok(Math.abs(ten - 10) / 10 < 0.005, `Expected ${ten} to be within 0.5% of 10`)
    assert.ok(Math.abs(hundred - 100) / 100 < 0.005, `Expected ${hundred} to be within 0.5% of 100`)
  })

  it('should reset the buckets as they are drained', () => {
    histogram.record(2.5)
    assert.strictEqual(drain().length, 1)
    assert.deepStrictEqual(drain(), [])

    histogram.record(2.5)
    assert.strictEqual(drain().length, 1)
  })

  describe('boundaries', () => {
    it('should report a duration below the resolution floor as 0', () => {
      // `MIN_MS` itself is the first resolved value, so the last value below it must land in the zero bucket
      histogram.record(MIN_MS - Number.EPSILON)
      histogram.record(0)

      assert.deepStrictEqual(drain(), [[0, 2]])
    })

    it('should resolve the resolution floor itself', () => {
      histogram.record(MIN_MS)

      const [[durationMs, count]] = drain()
      assert.strictEqual(count, 1)
      assert.ok(durationMs >= MIN_MS, `Expected ${durationMs} to be at least ${MIN_MS}`)
      assert.ok(Math.abs(durationMs - MIN_MS) / MIN_MS < 0.005)
    })

    it('should clamp a duration at or above the range ceiling', () => {
      histogram.record(MAX_MS)
      histogram.record(MAX_MS * 1000)
      histogram.record(Number.MAX_VALUE)
      histogram.record(Infinity)

      assert.deepStrictEqual(drain(), [[MAX_MS, 4]])
    })

    it('should keep the last duration below the range ceiling out of the overflow bucket', () => {
      histogram.record(MAX_MS / 1.01)

      const [[durationMs, count]] = drain()
      assert.strictEqual(count, 1)
      assert.ok(durationMs < MAX_MS, `Expected ${durationMs} to be below ${MAX_MS}`)
    })

    it('should not throw on a duration that is not a number', () => {
      histogram.record(Number.NaN)
      histogram.record(-1)

      // Both are impossible for a monotonic clock, but must not corrupt the buffer or throw a `RangeError`
      assert.deepStrictEqual(drain(), [[0, 2]])
    })
  })

  describe('sharing', () => {
    it('should let a second instance over the same buffer see what the first recorded', () => {
      const buffer = PauseDurationHistogram.createBuffer()
      const writer = new PauseDurationHistogram(buffer)
      const reader = new PauseDurationHistogram(buffer)

      writer.record(2.5)
      writer.record(2.5)

      const [[durationMs, count]] = drain(reader)
      assert.strictEqual(count, 2)
      assert.ok(Math.abs(durationMs - 2.5) / 2.5 < 0.005)
      // The reader's drain reset the shared buckets, so the writer's view is empty too
      assert.deepStrictEqual(drain(writer), [])
    })

    it('should bound its memory regardless of how many pauses are recorded', () => {
      const buffer = PauseDurationHistogram.createBuffer()
      const instance = new PauseDurationHistogram(buffer)
      for (let i = 0; i < 100_000; i++) instance.record(1 + (i % 1000) / 100)

      assert.strictEqual(buffer.byteLength, PauseDurationHistogram.createBuffer().byteLength)
      assert.ok(buffer.byteLength < 16 * 1024, `Expected ${buffer.byteLength} bytes to be a small fixed buffer`)
      assert.strictEqual(drain(instance).reduce((total, [, count]) => total + count, 0), 100_000)
    })
  })

  it('should skip a bucket whose count wrapped past the signed 32-bit maximum', () => {
    const buffer = PauseDurationHistogram.createBuffer()
    const instance = new PauseDurationHistogram(buffer)
    instance.record(2.5)
    const bucket = new Int32Array(buffer).findIndex((count) => count === 1)
    // Reaching this takes billions of pauses within a single flush interval, but must not reach the sketch, which
    // throws on a non-positive weight
    new Int32Array(buffer)[bucket] = -1

    assert.deepStrictEqual(drain(instance), [])
  })
})
