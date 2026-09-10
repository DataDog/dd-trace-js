'use strict'

/**
 * @param {unknown} reason
 * @param {unknown[]} reasons
 */
function collectReason (reason, reasons) {
  if (reason instanceof AggregateError) {
    for (const error of reason.errors) collectReason(error, reasons)
    return
  }

  reasons.push(reason)
}

/**
 * Preserves a single rejection reason and aggregates independent failures.
 * @param {unknown[]} flushReasons
 * @returns {unknown}
 */
function getFlushError (flushReasons) {
  if (flushReasons.length < 2) return flushReasons[0]

  const reasons = []
  for (const reason of flushReasons) collectReason(reason, reasons)

  return new AggregateError(reasons, 'Multiple errors occurred while flushing')
}

module.exports = getFlushError
