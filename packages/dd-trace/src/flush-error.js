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
  let flushError
  if (flushReasons.length > 0) {
    const reasons = []
    for (const reason of flushReasons) collectReason(reason, reasons)

    flushError = reasons.length === 1
      ? reasons[0]
      : new AggregateError(reasons, 'Multiple errors occurred while flushing')
  }
  return flushError
}

module.exports = getFlushError
