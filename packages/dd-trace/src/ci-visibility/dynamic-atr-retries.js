'use strict'

const log = require('../log')
const { getEnvironmentVariable } = require('../config/helper')

const {
  retriesForDuration,
  retryBucketIndexForDuration,
} = require('./efd-retry-policy')

const DYNAMIC_ATR_ENABLED_ENV = 'DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED'
const DYNAMIC_ATR_BUCKETS_ENV = 'DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS'

const RETRY_BUCKET_COUNT = 5
const MAX_RETRIES_PER_BUCKET = 20

/**
 * Returns whether duration-based ATR retry budgets are enabled.
 *
 * @returns {boolean}
 */
function isDynamicAtrEnabled () {
  const value = getEnvironmentVariable(DYNAMIC_ATR_ENABLED_ENV)
  if (value === undefined || value === '') {
    return false
  }
  return /^(true|1)$/i.test(value)
}

/**
 * Parses and validates the custom ATR retry buckets from the environment.
 *
 * Returns a frozen array of 5 positive integers in [1, 20], or `null`
 * when the variable is unset/empty or invalid (in which case the EFD retry
 * settings from the backend are used).
 *
 * @returns {number[] | null}
 */
function getDynamicAtrBuckets () {
  const raw = getEnvironmentVariable(DYNAMIC_ATR_BUCKETS_ENV)
  if (raw === undefined || raw === '') {
    return null
  }

  const parts = raw.split(',')
  if (parts.length !== RETRY_BUCKET_COUNT) {
    log.warn(
      'Invalid %s value %o; expected five comma-separated integers in [1, %d]',
      DYNAMIC_ATR_BUCKETS_ENV, raw, MAX_RETRIES_PER_BUCKET
    )
    return null
  }

  const buckets = []
  for (const part of parts) {
    const trimmedPart = part.trim()
    if (!/^\d+$/.test(trimmedPart)) {
      log.warn(
        'Invalid %s value %o; expected five comma-separated integers in [1, %d]',
        DYNAMIC_ATR_BUCKETS_ENV, raw, MAX_RETRIES_PER_BUCKET
      )
      return null
    }
    const value = Number(trimmedPart)
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETRIES_PER_BUCKET) {
      log.warn(
        'Invalid %s value %o; expected five comma-separated integers in [1, %d]',
        DYNAMIC_ATR_BUCKETS_ENV, raw, MAX_RETRIES_PER_BUCKET
      )
      return null
    }
    buckets.push(value)
  }

  return Object.freeze(buckets)
}

/**
 * Computes the dynamic ATR retry count for a test based on its initial-attempt
 * duration.
 *
 * When `customBuckets` is provided, the bucket at the duration index is used.
 * Otherwise, the EFD retry policy's `retriesForDuration` is used.
 *
 * The result is clamped to a minimum of 1.
 *
 * @param {number} durationMs - Initial-attempt duration in milliseconds.
 * @param {import('./efd-retry-policy').EfdRetryPolicy} efdRetryPolicy
 * @param {number[] | null} customBuckets
 * @returns {number}
 */
function getDynamicAtrRetryCount (durationMs, efdRetryPolicy, customBuckets) {
  let retryCount
  if (customBuckets) {
    retryCount = customBuckets[retryBucketIndexForDuration(durationMs)]
  } else {
    retryCount = retriesForDuration(durationMs, efdRetryPolicy)
  }
  return Math.max(1, retryCount)
}

module.exports = {
  DYNAMIC_ATR_BUCKETS_ENV,
  DYNAMIC_ATR_ENABLED_ENV,
  getDynamicAtrBuckets,
  getDynamicAtrRetryCount,
  isDynamicAtrEnabled,
}
