'use strict'

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000

/**
 * Returns the delay requested by a Test Optimization intake rate-limit response.
 *
 * @param {import('node:http').IncomingHttpHeaders} [headers]
 * @returns {number}
 */
function getRateLimitResetDelay (headers) {
  let retryAfter = headers?.['retry-after']
  if (Array.isArray(retryAfter)) retryAfter = retryAfter[0]
  if (typeof retryAfter === 'string' && retryAfter.trim() !== '') {
    const delaySeconds = Number(retryAfter)
    if (Number.isFinite(delaySeconds)) {
      if (delaySeconds >= 0) return delaySeconds * 1000
    } else {
      const resetTimestamp = Date.parse(retryAfter)
      if (Number.isFinite(resetTimestamp)) return Math.max(0, resetTimestamp - Date.now())
    }
  }

  let reset = headers?.['x-ratelimit-reset']
  if (Array.isArray(reset)) reset = reset[0]
  if (typeof reset !== 'string' || reset.trim() === '') return NaN

  const resetSeconds = Number(reset)
  if (!Number.isFinite(resetSeconds) || resetSeconds < 0) return NaN

  // Datadog defines this header as delay seconds. Preserve compatibility with
  // realistic Unix timestamps without confusing ordinary durations with epochs.
  if (resetSeconds >= EPOCH_SECONDS_THRESHOLD) {
    return Math.max(0, resetSeconds * 1000 - Date.now())
  }
  return resetSeconds * 1000
}

module.exports = { getRateLimitResetDelay }
