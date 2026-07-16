'use strict'

const EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS = [
  { limitMs: 5000, key: '5s' },
  { limitMs: 10_000, key: '10s' },
  { limitMs: 30_000, key: '30s' },
  { limitMs: 300_000, key: '5m' },
]

/**
 * @param {number} durationMs
 * @param {Record<string, number>} slowTestRetries
 * @returns {number}
 */
function getEfdRetryCount (durationMs, slowTestRetries) {
  for (const { limitMs, key } of EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS) {
    if (durationMs < limitMs) {
      return slowTestRetries[key] ?? 0
    }
  }
  return 0
}

/**
 * @param {Record<string, number> | undefined} slowTestRetries
 * @returns {number | undefined}
 */
function getMaxEfdRetryCount (slowTestRetries) {
  let maxRetryCount
  for (const { key } of EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS) {
    const retryCount = slowTestRetries?.[key]
    if (retryCount !== undefined && (maxRetryCount === undefined || retryCount > maxRetryCount)) {
      maxRetryCount = retryCount
    }
  }
  return maxRetryCount
}

/**
 * @param {Record<string, number>} slowTestRetries
 * @returns {number}
 */
function getEfdSchedulingRetryCount (slowTestRetries) {
  return getMaxEfdRetryCount(slowTestRetries) ?? 0
}

module.exports = {
  EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS,
  getEfdRetryCount,
  getEfdSchedulingRetryCount,
  getMaxEfdRetryCount,
}
