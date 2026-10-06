'use strict'

const { LogCollapsingLowestDenseDDSketch } = require('../../../../vendor/dist/@datadog/sketches-js')

/**
 * Durations of the pauses caused by probes, shared between the debugger worker thread and the main thread.
 *
 * The worker records the duration of every pause, while the main thread converts them into a telemetry distribution.
 * The main thread can't process a message while the application keeps it busy, for example in a synchronous loop that
 * hits a probe on every iteration, so a message per pause would queue up without bound. Instead the worker counts each
 * duration in a fixed set of buckets in a shared buffer using atomics, and the main thread periodically drains the
 * buckets. Memory use is therefore constant no matter how many pauses happen between two drains.
 *
 * The buckets are the keys of the mapping used by the DDSketch backing telemetry distributions. Each drained bucket is
 * reported as the value the sketch maps back to the same key, so the resulting distribution is as accurate as tracking
 * each duration individually. Durations outside of the covered range are counted in the closest bucket.
 */

// Created the same way as the sketch of telemetry distributions, so both map durations to the same keys
const { mapping } = new LogCollapsingLowestDenseDDSketch()

const MIN_KEY = mapping.key(0.001) // 1 µs
const MAX_KEY = mapping.key(60 * 60 * 1000) // 1 hour
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
    const key = Math.min(Math.max(mapping.key(durationMs), MIN_KEY), MAX_KEY)
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
        report(mapping.value(MIN_KEY + i), count)
      }
    }
  }
}

module.exports = {
  PauseDurationHistogram,
}
