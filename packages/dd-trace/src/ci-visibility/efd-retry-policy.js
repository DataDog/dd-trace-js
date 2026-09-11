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
/**
 * Returns the zero-based retry-bucket index for a test duration.
 *
 * Bucket boundaries (ms): 5 000, 10 000, 30 000, 300 000.
 * Durations at or above a boundary fall into the next bucket.
 *
 * @param {number} durationMs
 * @returns {number}
 */
function retryBucketIndexForDuration (durationMs) {
  for (let index = 0; index < EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS.length; index++) {
    if (durationMs < EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS[index].limitMs) {
      return index
    }
  }
  return EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS.length // > 5 m bucket
}

/**
 * Returns the configured retry budget for a test duration.
 *
 * @param {number} durationMs
 * @param {EfdRetryPolicy} retryPolicy
 * @returns {number}
 */
function retriesForDuration (durationMs, retryPolicy) {
  const index = retryBucketIndexForDuration(durationMs)
  if (index < retryPolicy.durationRetryCounts.length) {
    return retryPolicy.durationRetryCounts[index].retryCount
  }
  return 0
}

function getEfdRetryCountForDuration (durationMs, retryPolicy) {
  return retriesForDuration(durationMs, retryPolicy)
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
  retriesForDuration,
  retryBucketIndexForDuration,
  shouldSkipEfdRetry,
}
