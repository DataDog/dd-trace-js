'use strict'

/**
 * Durations of the pauses caused by probes, shared between the debugger worker thread and the main thread.
 *
 * The worker records the duration of every pause, while the main thread converts them into a telemetry distribution.
 * The main thread can't process a message while the application keeps it busy, for example in a synchronous loop that
 * hits a probe on every iteration, so a message per pause would queue up without bound. Instead the worker counts each
 * duration in a fixed set of buckets in a shared buffer using atomics, and the main thread periodically drains the
 * buckets. Memory use is therefore constant no matter how many pauses happen between two drains.
 *
 * The buckets use the logarithmic mapping and relative accuracy of the DDSketch backing telemetry distributions. Each
 * drained bucket is reported as a value the sketch maps back to the same bucket, so the resulting distribution is as
 * accurate as tracking each duration individually. Durations outside of the covered range are counted in the closest
 * bucket.
 */

// Keep in sync with the DDSketch used by telemetry distributions. If they differ, the coarser accuracy wins.
const RELATIVE_ACCURACY = 0.01
const GAMMA = (1 + RELATIVE_ACCURACY) / (1 - RELATIVE_ACCURACY)
const LOG_GAMMA = Math.log(GAMMA)
// A bucket covers (GAMMA ** (key - 1), GAMMA ** key]. Relative to its upper bound, this is the value with the same
// relative distance to both bounds, which is also what DDSketch reports for the bucket.
const BUCKET_VALUE_FACTOR = 2 / (1 + GAMMA)

const MIN_KEY = getKey(0.001) // 1 µs
const MAX_KEY = getKey(60 * 60 * 1000) // 1 hour
const BUCKET_COUNT = MAX_KEY - MIN_KEY + 1

class PauseDurationHistogram {
  /** @type {Uint32Array} */
  #counts

  /**
   * @param {SharedArrayBuffer} buffer - A buffer created with {@link PauseDurationHistogram.createBuffer}
   */
  constructor (buffer) {
    this.#counts = new Uint32Array(buffer)
  }

  /**
   * Create the shared buffer backing the histogram.
   *
   * @returns {SharedArrayBuffer}
   */
  static createBuffer () {
    return new SharedArrayBuffer(BUCKET_COUNT * Uint32Array.BYTES_PER_ELEMENT)
  }

  /**
   * Record the duration of a single pause.
   *
   * @param {number} durationMs - The pause duration, in milliseconds
   */
  record (durationMs) {
    const key = Math.min(Math.max(getKey(durationMs), MIN_KEY), MAX_KEY)
    Atomics.add(this.#counts, key - MIN_KEY, 1)
  }

  /**
   * Reset all buckets and report the ones that were non-empty.
   *
   * @param {(durationMs: number, count: number) => void} report - Called once per non-empty bucket with the duration
   *   representing the bucket and the number of pauses counted in it
   */
  drain (report) {
    for (let i = 0; i < BUCKET_COUNT; i++) {
      const count = Atomics.exchange(this.#counts, i, 0)
      if (count !== 0) {
        report(GAMMA ** (MIN_KEY + i) * BUCKET_VALUE_FACTOR, count)
      }
    }
  }
}

/**
 * @param {number} durationMs
 */
function getKey (durationMs) {
  return Math.ceil(Math.log(durationMs) / LOG_GAMMA)
}

module.exports = {
  PauseDurationHistogram,
}
