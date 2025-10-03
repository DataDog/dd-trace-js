'use strict'

const { SAMPLING_MECHANISM_APPSEC } = require('../constants')
const RateLimiter = require('../rate_limiter')

/**
 * Returns a rate limiter tuned for the provided product configuration.
 *
 * @param {{ appsec?: { enabled?: boolean }, iast?: { enabled?: boolean } } | undefined} config
 * @returns {import('../rate_limiter')}
 */
function getProductRateLimiter (config) {
  if (config?.appsec?.enabled || config?.iast?.enabled) {
    return new RateLimiter(1, 'minute') // onePerMinute
  }

  return new RateLimiter(0) // dropAll
}

/**
 * Available products and their identifiers/mechanisms.
 */
const PRODUCTS = {
  APM: { id: 1 << 0 },
  ASM: { id: 1 << 1, mechanism: SAMPLING_MECHANISM_APPSEC },
  DSM: { id: 1 << 2 },
  DJM: { id: 1 << 3 },
  DBM: { id: 1 << 4 }
}

module.exports = {
  ...PRODUCTS,

  getProductRateLimiter
}
