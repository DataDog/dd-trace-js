'use strict'

const durations = new WeakMap()

/**
 * Mark a span as started in the compatibility lifecycle projection.
 *
 * @param {object} span
 */
function markSpanStarted (span) {
  durations.delete(span)
}

/**
 * Mark a span as finished in the compatibility lifecycle projection.
 *
 * @param {object} span
 * @param {number} duration
 */
function markSpanFinished (span, duration) {
  durations.set(span, duration)
}

/**
 * Check the write-time lifecycle projection without reading native span state.
 *
 * @param {object} span
 * @returns {boolean}
 */
function isSpanFinished (span) {
  return durations.has(span)
}

/**
 * Read the duration projected by the finish event.
 *
 * @param {object} span
 * @returns {number|undefined}
 */
function getSpanDuration (span) {
  return durations.get(span)
}

module.exports = { getSpanDuration, isSpanFinished, markSpanFinished, markSpanStarted }
