'use strict'

const FINAL_FLUSH_TIMEOUT = 60_000
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
}
