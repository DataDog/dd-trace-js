'use strict'

const { SAMPLING_MECHANISM_APPSEC } = require('../constants')
const RateLimiter = require('../rate_limiter')

const dropAll = new RateLimiter(0)
const onePerMinute = new RateLimiter(1, 'minute')

function getProductRateLimiter (config) {
  if (config?.appsec?.enabled || config?.iast?.enabled) {
    return onePerMinute
  }
  return dropAll
}

module.exports = {
  APM: { id: 1 << 0 },
  ASM: { id: 1 << 1, mechanism: SAMPLING_MECHANISM_APPSEC },
  DSM: { id: 1 << 2 },
  DJM: { id: 1 << 3 },
  DBM: { id: 1 << 4 },

  getProductRateLimiter
}
