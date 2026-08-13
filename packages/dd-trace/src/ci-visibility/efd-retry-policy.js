'use strict'

const EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS = [
  { limitMs: 5000, key: '5s' },
  { limitMs: 10_000, key: '10s' },
  { limitMs: 30_000, key: '30s' },
  { limitMs: 300_000, key: '5m' },
]

// A bucket the settings validator accepts but this module ignores silently loses its retries.
const EARLY_FLAKE_DETECTION_RETRY_BUCKETS =
  Object.freeze(EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS.map(({ key }) => key))

/**
 * @typedef {object} EfdDurationRetryCount
 * @property {number} durationLimitMs
 * @property {number} retryCount
 */

/**
 * @typedef {object} EfdRetryPolicy
 * @property {readonly EfdDurationRetryCount[]} durationRetryCounts
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
 * @param {Record<string, unknown> | undefined} retriesByDuration
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
    durationRetryCounts.push(Object.freeze({ durationLimitMs, retryCount }))
    if (retryCount > schedulingRetryCount) {
      schedulingRetryCount = retryCount
    }
  }
  return Object.freeze({
    durationRetryCounts: Object.freeze(durationRetryCounts),
    schedulingRetryCount,
  })
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

const EMPTY_EFD_RETRY_POLICY = createEfdRetryPolicy()

module.exports = {
  EARLY_FLAKE_DETECTION_RETRY_BUCKETS,
  EMPTY_EFD_RETRY_POLICY,
  createEfdRetryPolicy,
  getEfdRetryCountForDuration,
  hasEfdRetries,
  shouldSkipEfdRetry,
}
