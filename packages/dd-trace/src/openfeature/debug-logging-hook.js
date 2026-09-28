'use strict'

const log = require('../log')

/**
 * OpenFeature hook that logs full evaluation details for every flag
 * evaluation, for troubleshooting during setup.
 *
 * Uses the tracer's existing log system (visible when DD_TRACE_DEBUG=true,
 * filterable with DD_TRACE_LOG_LEVEL) rather than a dedicated switch, so
 * there is nothing new for customers to learn.
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
    try {
      log.debug('Feature Flags: evaluated %s: %o', hookContext?.flagKey, evaluationDetails)
    } catch (error) {
      // A diagnostic failure (e.g. a custom inspect method that throws while formatting
      // evaluationDetails for %o) must not escape this `finally` hook and disrupt the
      // actual flag evaluation. Contain it here, same as SpanEnrichmentHook.finally().
      log.warn('DebugLoggingHook: error in finally hook: %s', error.message)
    }
  }
}

module.exports = DebugLoggingHook
