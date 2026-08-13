'use strict'

require('../setup/core')

const assert = require('node:assert/strict')

const { LANES, nowMillis, splitMillisToNanoLanes, subtractNanoLanes } = require('../../src/native-spans/clock')

const UINT32_SPAN = 4_294_967_296

/**
 * @returns {bigint} The 64-bit value the scratch lanes currently hold.
 */
function lanes () {
  return (BigInt(LANES[0]) << 32n) | BigInt(LANES[1])
}

describe('native-spans clock', () => {
  describe('splitMillisToNanoLanes', () => {
    it('is exact at present-day timestamps', () => {
      // 2026-08-13T00:00:00.000Z. Naive `ms * 1e6` is 1.786e18, past
      // `Number.MAX_SAFE_INTEGER`, where the double quantises to ~256 ns steps.
      const milliseconds = 1_786_060_800_000

      splitMillisToNanoLanes(milliseconds)

      assert.strictEqual(lanes(), BigInt(milliseconds) * 1_000_000n)
    })

    it('keeps sub-millisecond precision', () => {
      // A binary fraction, so the input carries exactly what it says at this
      // magnitude and the expectation can be exact. A decimal fraction like
      // `.123456` could not: doubles step by ~244 ns up here, so the *input* would
      // already be a different number than written.
      splitMillisToNanoLanes(1_786_060_800_000.5)
      assert.strictEqual(lanes(), 1_786_060_800_000_500_000n)

      splitMillisToNanoLanes(1_786_060_800_000.25)
      assert.strictEqual(lanes(), 1_786_060_800_000_250_000n)
    })

    it('rounds the fractional part rather than truncating it', () => {
      // Small magnitude, where a double holds sub-nanosecond fractions exactly, so
      // the rounding direction is what is under test and nothing else.
      splitMillisToNanoLanes(1000.000_000_4)
      assert.strictEqual(lanes(), 1_000_000_000n)

      splitMillisToNanoLanes(1000.000_000_6)
      assert.strictEqual(lanes(), 1_000_000_001n)
    })

    it('handles the epoch', () => {
      splitMillisToNanoLanes(0)

      assert.strictEqual(LANES[0], 0)
      assert.strictEqual(LANES[1], 0)
    })

    it('carries into the high lane exactly at the boundary', () => {
      // One nanosecond below 2^32 stays entirely in the low lane; 2^32 is the first
      // value that must carry.
      splitMillisToNanoLanes((UINT32_SPAN - 1) / 1_000_000)
      assert.strictEqual(LANES[0], 0)
      assert.strictEqual(LANES[1], UINT32_SPAN - 1)

      splitMillisToNanoLanes(UINT32_SPAN / 1_000_000)
      assert.strictEqual(LANES[0], 1)
      assert.strictEqual(LANES[1], 0)
    })

    it('stays exact across a sweep of realistic timestamps', () => {
      for (let offset = 0; offset < 5000; offset += 7) {
        const milliseconds = 1_786_060_800_000 + offset
        splitMillisToNanoLanes(milliseconds)
        assert.strictEqual(lanes(), BigInt(milliseconds) * 1_000_000n, `failed at +${offset}ms`)
      }
    })
  })

  describe('subtractNanoLanes', () => {
    it('subtracts within a single lane', () => {
      subtractNanoLanes(0, 1000, 0, 4000)

      assert.strictEqual(lanes(), 3000n)
    })

    it('borrows from the high lane', () => {
      subtractNanoLanes(1, 10, 2, 4)

      assert.strictEqual(lanes(), BigInt(UINT32_SPAN) + 4n - 10n)
    })

    it('returns zero for a duration whose start and end are identical', () => {
      subtractNanoLanes(7, 7, 7, 7)

      assert.strictEqual(lanes(), 0n)
    })

    it('returns zero rather than wrapping when the clock stepped backwards', () => {
      // Without the guard the borrow wraps the high lane to ~2^32, i.e. a ~584-year
      // duration on the wire.
      subtractNanoLanes(5, 0, 4, 0)

      assert.strictEqual(lanes(), 0n)
    })

    it('returns zero on a backwards step that only borrows', () => {
      subtractNanoLanes(0, 10, 0, 4)

      assert.strictEqual(lanes(), 0n)
    })

    it('round-trips a duration through both split and subtract', () => {
      const startMillis = 1_786_060_800_000.5
      const finishMillis = startMillis + 1.25

      splitMillisToNanoLanes(startMillis)
      const startHi = LANES[0]
      const startLo = LANES[1]

      splitMillisToNanoLanes(finishMillis)
      subtractNanoLanes(startHi, startLo, LANES[0], LANES[1])

      assert.strictEqual(lanes(), 1_250_000n)
    })
  })

  describe('nowMillis', () => {
    it('reads as a wall-clock millisecond value', () => {
      const before = Date.now()
      const reading = nowMillis()
      const after = Date.now()

      // The anchor is taken once at module load, so a reading can drift from
      // `Date.now()` — a second of slack, not exactness, is what is being pinned.
      assert.ok(reading >= before - 1000, `${reading} is not close to ${before}`)
      assert.ok(reading <= after + 1000, `${reading} is not close to ${after}`)
    })

    it('does not go backwards', () => {
      const first = nowMillis()
      const second = nowMillis()

      assert.ok(second >= first)
    })
  })
})
