'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../setup/mocha')

const { Namespace } = require('../../src/telemetry/metrics')
const { PauseDurationHistogram } = require('../../src/debugger/pause-duration-histogram')

describe('debugger/pause-duration-histogram', () => {
  /** @type {SharedArrayBuffer} */
  let buffer
  /** @type {PauseDurationHistogram} */
  let workerHistogram
  /** @type {PauseDurationHistogram} */
  let mainHistogram

  beforeEach(() => {
    buffer = PauseDurationHistogram.createBuffer()
    workerHistogram = new PauseDurationHistogram(buffer)
    mainHistogram = new PauseDurationHistogram(buffer)
  })

  it('should create a shared buffer', () => {
    assert.ok(buffer instanceof SharedArrayBuffer)
  })

  it('should report nothing when no duration was recorded', () => {
    assert.deepStrictEqual(drain(), [])
  })

  it('should report the recorded durations in ascending order, counting similar durations together', () => {
    workerHistogram.record(3.5)
    workerHistogram.record(1.25)
    workerHistogram.record(1000)
    workerHistogram.record(1.25)
    workerHistogram.record(1.251)

    assertDrained([[1.25, 3], [3.5, 1], [1000, 1]])
  })

  it('should reset the durations when drained', () => {
    workerHistogram.record(2)
    drain()

    assert.deepStrictEqual(drain(), [])

    workerHistogram.record(3)

    assertDrained([[3, 1]])
  })

  // A bucket spans about 2%, so a duration 3% beyond a bound would be counted in a separate bucket if it wasn't clamped

  it('should count durations below 1 µs as 1 µs', () => {
    workerHistogram.record(0.001)
    workerHistogram.record(0.001 / 1.03)
    workerHistogram.record(0)

    assertDrained([[0.001, 3]])
  })

  it('should count durations above 1 hour as 1 hour', () => {
    const hourMs = 60 * 60 * 1000
    workerHistogram.record(hourMs)
    workerHistogram.record(hourMs * 1.03)
    workerHistogram.record(Number.MAX_VALUE)

    assertDrained([[hourMs, 3]])
  })

  it('should produce the same telemetry distribution as tracking each duration individually', () => {
    const durationsMs = [0.003, 0.05, 0.2, 0.2, 1, 1.7, 2.5, 2.5, 2.5, 13, 80, 450, 9000, 120_000]
    const namespace = new Namespace('test')
    const individual = namespace.distribution('individual')
    const drained = namespace.distribution('drained')

    for (const durationMs of durationsMs) {
      workerHistogram.record(durationMs)
      individual.track(durationMs)
    }
    mainHistogram.drain((durationMs, count) => drained.track(durationMs, count))

    assert.strictEqual(drained.pointCount, durationsMs.length)
    assert.strictEqual(drained.sketch.count, individual.sketch.count)
    for (let quantile = 0; quantile <= 1; quantile += 0.05) {
      assert.strictEqual(
        drained.sketch.getValueAtQuantile(quantile),
        individual.sketch.getValueAtQuantile(quantile),
        `quantile ${quantile}`
      )
    }
  })

  /**
   * @returns {Array<[number, number]>}
   */
  function drain () {
    /** @type {Array<[number, number]>} */
    const reports = []
    mainHistogram.drain((durationMs, count) => {
      reports.push([durationMs, count])
    })
    return reports
  }

  /**
   * @param {Array<[number, number]>} expected - The expected durations, in milliseconds, and their counts
   */
  function assertDrained (expected) {
    const reports = drain()
    assert.deepStrictEqual(reports.map(([, count]) => count), expected.map(([, count]) => count))
    for (const [i, [durationMs]] of reports.entries()) {
      const expectedMs = expected[i][0]
      // The durations are reported with a relative accuracy of 1%
      assert.ok(Math.abs(durationMs - expectedMs) <= expectedMs * 0.01, `Expected ${durationMs} to be ~${expectedMs}`)
    }
  }
})
