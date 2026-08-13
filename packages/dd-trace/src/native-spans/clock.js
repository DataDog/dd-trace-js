'use strict'

const { performance } = require('node:perf_hooks')

const now = performance.now.bind(performance)

const UINT32_SPAN = 4_294_967_296
const NANOS_PER_MILLI = 1_000_000

// One process-wide wall-clock anchor instead of the baseline's per-trace
// `{ startTime, ticks }` pair: "Retained per-context state" leaves nowhere to
// keep a per-segment anchor, and a single origin costs nothing per span.
const ORIGIN_MILLIS = Date.now()
const ORIGIN_TICKS = now()

/**
 * Scratch lanes for the most recent split. Read `LANES[0]` (hi) and `LANES[1]`
 * (lo) immediately after calling a split function; the array is reused, so
 * nothing may intervene. Avoids returning a fresh pair object per timestamp on
 * a path that runs once per span start, finish and event.
 */
const LANES = new Uint32Array(2)

/**
 * @returns {number} Wall-clock milliseconds with sub-millisecond precision.
 */
function nowMillis () {
  return ORIGIN_MILLIS + now() - ORIGIN_TICKS
}

/**
 * Split `milliseconds` into integer-nanosecond `Uint32Array` lanes.
 *
 * Epoch nanoseconds pass `Number.MAX_SAFE_INTEGER`, so the multiply is done in
 * halves: the whole-millisecond count splits across 2^32 first, and each half is
 * scaled by 1e6 separately. Every intermediate stays under 2^53, which makes
 * this exact — the baseline's `Math.round(ms * 1e6)` in `span_format.js` is not,
 * it quantises to ~256 ns at present-day timestamps.
 *
 * @param {number} milliseconds
 */
function splitMillisToNanoLanes (milliseconds) {
  const wholeMillis = Math.floor(milliseconds)
  const fractionNanos = Math.round((milliseconds - wholeMillis) * NANOS_PER_MILLI)

  const millisHi = Math.floor(wholeMillis / UINT32_SPAN)
  const millisLo = wholeMillis - millisHi * UINT32_SPAN

  let lo = millisLo * NANOS_PER_MILLI + fractionNanos
  const carry = Math.floor(lo / UINT32_SPAN)
  lo -= carry * UINT32_SPAN

  LANES[0] = millisHi * NANOS_PER_MILLI + carry
  LANES[1] = lo
}

/**
 * Lane-wise `end - start` in nanoseconds. A non-monotonic pair (the wall clock
 * stepped backwards between start and finish) yields zero rather than a
 * ~584-year duration from the borrow wrapping.
 *
 * @param {number} startHi
 * @param {number} startLo
 * @param {number} endHi
 * @param {number} endLo
 */
function subtractNanoLanes (startHi, startLo, endHi, endLo) {
  let lo = endLo - startLo
  let hi = endHi - startHi

  if (lo < 0) {
    lo += UINT32_SPAN
    hi -= 1
  }

  if (hi < 0) {
    LANES[0] = 0
    LANES[1] = 0
    return
  }

  LANES[0] = hi
  LANES[1] = lo
}

module.exports = { LANES, nowMillis, splitMillisToNanoLanes, subtractNanoLanes }
