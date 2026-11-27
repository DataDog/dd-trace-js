'use strict'

const { getValueFromEnvSources } = require('../config/helper')

// Integration tests shorten this to exercise the deadline without waiting a full minute.
const FINAL_FLUSH_TIMEOUT = getValueFromEnvSources('_DD_CIVISIBILITY_FINAL_FLUSH_TIMEOUT_MS')
const FINAL_FLUSH_FALLBACK_DELAY = 100
const FINAL_FLUSH_TIMEOUT_CODE = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'

/**
 * @returns {Error & { code: string }}
 */
function createFinalFlushTimeoutError () {
  const error = new Error('Timed out waiting for Test Optimization to flush')
  error.code = FINAL_FLUSH_TIMEOUT_CODE
  return error
}

module.exports = {
  createFinalFlushTimeoutError,
  FINAL_FLUSH_FALLBACK_DELAY,
  FINAL_FLUSH_TIMEOUT,
  FINAL_FLUSH_TIMEOUT_CODE,
}
