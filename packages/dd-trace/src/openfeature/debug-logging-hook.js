'use strict'

const log = require('../log')

/**
 * Logs full evaluation details under DD_TRACE_DEBUG, matching EvalMetricsHook's use of `finally`.
 */
class DebugLoggingHook {
  /**
   * @param {{ flagKey: string }} hookContext - Hook context containing the flag key
   * @param {object} evaluationDetails - Full evaluation details
   */
  finally (hookContext, evaluationDetails) {
    try {
      log.debug('Feature Flags: evaluated %s: %o', hookContext?.flagKey, evaluationDetails)
    } catch (error) {
      try {
        // Defense in depth; the OpenFeature SDK already guards finally hooks.
        log.warn('DebugLoggingHook: error in finally hook: %s', error.message)
      } catch { /* logging failure must not crash evaluation */ }
    }
  }
}

module.exports = DebugLoggingHook
