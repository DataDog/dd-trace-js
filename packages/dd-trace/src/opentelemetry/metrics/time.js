'use strict'

const { timeOrigin } = performance

/**
 * Current wall-clock time as UNIX epoch nanoseconds, the unit OTLP requires for
 * `timeUnixNano` / `startTimeUnixNano`. `process.hrtime.bigint()` is a monotonic
 * clock with an arbitrary origin, so its values decode as 1970 timestamps that
 * the Datadog Agent silently drops. Anchoring on `performance.timeOrigin` puts
 * the value on the epoch while `performance.now()` keeps it monotonic, so a
 * backward wall-clock jump can't make `timeUnixNano` precede `startTimeUnixNano`.
 *
 * @returns {number} Nanoseconds since the UNIX epoch
 */
function nowUnixNano () {
  return Math.round((timeOrigin + performance.now()) * 1e6)
}

module.exports = { nowUnixNano }
