'use strict'

/**
 * Execution pause durations shared between the debugger worker thread and the main thread.
 *
 * The worker measures how long the instrumented thread was suspended for each `Debugger.paused` event, but it can't
 * hand the value over as a message: a probe inside a long synchronous function keeps hitting its breakpoint without
 * the instrumented thread ever reaching its event loop, so anything posted over a `MessagePort` piles up unbounded
 * until that function returns and then arrives as one burst of telemetry calls. Instead the worker adds each duration
 * to a bucket in a shared histogram using atomics, and the main thread drains the buckets into a telemetry
 * distribution at a fixed interval. Recording is allocation-free, and both the memory held and the work done per
 * drain are bounded by the bucket count no matter how many pauses happened in between.
 */

/**
 * Durations below this are reported as 0. A pause costs at least one CDP round trip, so this is far below anything
 * actually measurable and only exists to give the logarithmic mapping a floor.
 */
const MIN_MS = 0.01

/**
 * Bucket growth factor. A bucket covers `[lo, lo * GAMMA)` and is reported at its geometric midpoint, which is within
 * `Math.sqrt(GAMMA) - 1` (~0.5%) of every value in it. That's finer than the relative accuracy of the DDSketch the
 * durations are drained into, so bucketing doesn't measurably widen the reported distribution.
 */
const GAMMA = 1.01
const LOG_GAMMA = Math.log(GAMMA)
const INV_LOG_GAMMA = 1 / LOG_GAMMA

/** Together with `MIN_MS` and `GAMMA`, this spans durations from 0.01 ms up to `MAX_MS` (~10 minutes). */
const BUCKET_COUNT = 1800

/**
 * Slot 0 holds durations below `MIN_MS`, slots 1 through `BUCKET_COUNT` hold the logarithmic buckets, and the final
 * slot holds everything at or above `MAX_MS`, which is reported as `MAX_MS`.
 */
const OVERFLOW_INDEX = BUCKET_COUNT + 1
const SLOT_COUNT = OVERFLOW_INDEX + 1
const MAX_MS = MIN_MS * GAMMA ** BUCKET_COUNT

class PauseDurationHistogram {
  /** @type {Int32Array} */
  #buckets

  /**
   * @param {SharedArrayBuffer} buffer - A buffer created with {@link PauseDurationHistogram.createBuffer}
   */
  constructor (buffer) {
    this.#buckets = new Int32Array(buffer)
  }

  /**
   * Create the shared buffer backing the histogram.
   *
   * @returns {SharedArrayBuffer}
   */
  static createBuffer () {
    return new SharedArrayBuffer(SLOT_COUNT * Int32Array.BYTES_PER_ELEMENT)
  }

  /**
   * Record how long the instrumented thread was suspended.
   *
   * @param {number} durationMs - The pause duration in milliseconds.
   */
  record (durationMs) {
    // `NaN` fails this comparison and lands in slot 0, and `Infinity` is clamped, so the index is always in range
    // without validating the input separately.
    const index = durationMs >= MIN_MS
      ? Math.min(1 + Math.floor(Math.log(durationMs / MIN_MS) * INV_LOG_GAMMA), OVERFLOW_INDEX)
      : 0
    Atomics.add(this.#buckets, index, 1)
  }

  /**
   * Reset all buckets and report the ones that held samples.
   *
   * @param {(durationMs: number, count: number) => void} report - Called once per non-empty bucket with the duration
   *   to report for that bucket and the number of pauses recorded in it.
   */
  drain (report) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const count = Atomics.exchange(this.#buckets, i, 0)
      // A count can only come out negative if `Atomics.add` wrapped, which takes billions of pauses within a single
      // interval. Such a count is meaningless and would be rejected downstream anyway, so drop it.
      if (count > 0) report(bucketDurationMs(i), count)
    }
  }
}

/**
 * The duration reported for every pause recorded in a bucket.
 *
 * @param {number} index - The bucket index.
 */
function bucketDurationMs (index) {
  if (index === 0) return 0
  if (index === OVERFLOW_INDEX) return MAX_MS
  // Geometric midpoint of `[MIN_MS * GAMMA ** (index - 1), MIN_MS * GAMMA ** index)`
  return MIN_MS * GAMMA ** (index - 0.5)
}

module.exports = {
  MAX_MS,
  MIN_MS,
  PauseDurationHistogram,
}
