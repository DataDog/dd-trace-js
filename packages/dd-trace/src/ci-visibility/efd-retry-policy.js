'use strict'

const EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS = [
  { limitMs: 5000, key: '5s' },
  { limitMs: 10_000, key: '10s' },
  { limitMs: 30_000, key: '30s' },
  { limitMs: 300_000, key: '5m' },
]

/**
 * @typedef {object} EfdDurationRetryCount
 * @property {number} durationLimitMs
 * @property {number} retryCount
 */

/**
 * @typedef {object} EfdRetryPolicy
 * @property {EfdDurationRetryCount[]} durationRetryCounts
 * @property {number} schedulingRetryCount
 */

/**
 * @param {number} durationMs
 * @param {EfdRetryPolicy} retryPolicy
 * @returns {number}
 */
function getEfdRetryCountForDuration (durationMs, retryPolicy) {
  for (const { durationLimitMs, retryCount } of retryPolicy.durationRetryCounts) {
    if (durationMs < durationLimitMs) {
      return retryCount
    }
  }
  return 0
}

/**
 * @param {Record<string, number> | undefined} retriesByDuration
 * @returns {EfdRetryPolicy}
 */
function createEfdRetryPolicy (retriesByDuration = {}) {
  const durationRetryCounts = []
  let schedulingRetryCount = 0
  for (const { limitMs: durationLimitMs, key } of EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS) {
    const configuredRetryCount = retriesByDuration[key]
    const retryCount = Number.isSafeInteger(configuredRetryCount) && configuredRetryCount >= 0
      ? configuredRetryCount
      : 0
    durationRetryCounts.push({ durationLimitMs, retryCount })
    if (retryCount > schedulingRetryCount) {
      schedulingRetryCount = retryCount
    }
  }
  return {
    durationRetryCounts,
    schedulingRetryCount,
  }
}

/**
 * @param {EfdRetryPolicy | undefined} retryPolicy
 * @returns {boolean}
 */
function hasEfdRetries (retryPolicy) {
  return (retryPolicy?.schedulingRetryCount ?? 0) > 0
}

/**
 * @param {number} retryIndex
 * @param {number | undefined} retryCount
 * @returns {boolean}
 */
function shouldSkipEfdRetry (retryIndex, retryCount) {
  return retryCount !== undefined && retryIndex > retryCount
}

module.exports = {
  createEfdRetryPolicy,
  getEfdRetryCountForDuration,
  hasEfdRetries,
  shouldSkipEfdRetry,
}
