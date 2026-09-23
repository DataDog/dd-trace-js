'use strict'

/**
 * OpenFeature hook that logs full evaluation details for every flag
 * evaluation to the console, for troubleshooting during setup.
 *
 * Implements the `finally` hook interface (not `after`) so it fires for
 * both successful and errored evaluations, matching `EvalMetricsHook`.
 */
class DebugLoggingHook {
  /**
   * Called by the OpenFeature SDK after every flag evaluation (success or error).
   *
   * @param {{ flagKey: string }} hookContext - Hook context containing the flag key
   * @param {object} evaluationDetails - Full evaluation details
   */
  finally (hookContext, evaluationDetails) {
    // eslint-disable-next-line no-console
    console.log('[dd-trace] Feature flag evaluated:', hookContext?.flagKey, evaluationDetails)
  }
}

module.exports = DebugLoggingHook
