'use strict'

/**
 * Fail a benchmark process that does not finish within its per-iteration budget.
 *
 * @param {string} name
 * @param {number} [timeout]
 * @returns {() => void}
 */
module.exports = function startTimeoutGuard (name, timeout = 30_000) {
  const timer = setTimeout(() => {
    throw new Error(`${name} did not finish within ${timeout / 1000} seconds`)
  }, timeout)

  return () => clearTimeout(timer)
}
