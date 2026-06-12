'use strict'

/**
 * FlagEvalEVPHook is a Finally-stage OpenFeature hook that does only a cheap
 * scalar extraction and a non-blocking enqueue to the FlagEvaluationsWriter.
 *
 * It MUST NOT perform inline aggregation, JSON.stringify, map lookups, or any
 * other work beyond the cheap capture described below — the eval hot path runs
 * synchronously for the caller, so every nanosecond here is charged directly
 * to the user's flag evaluation.
 *
 * The existing EvalMetricsHook (OTel feature_flag.evaluations) is untouched —
 * this hook is registered IN ADDITION to it, not as a replacement.
 */
class FlagEvalEVPHook {
  /** @type {import('./flag_evaluations')} */
  _writer

  /**
   * @param {import('./flag_evaluations')} writer - FlagEvaluationsWriter instance
   */
  constructor (writer) {
    this._writer = writer
  }

  /**
   * Called by the OpenFeature SDK after every flag evaluation (success, error, or default).
   * Using the `finally` stage (not `after`) ensures error and default paths are covered.
   *
   * Cheap capture only — no aggregation, no stringify, no blocking:
   *   - Scalar field extraction from hookContext + evaluationDetails
   *   - Read flagMetadata for allocationKey and eval-time stamp
   *   - Non-blocking enqueue to the writer's aggregation loop
   *
   * @param {{ flagKey: string, flagMetadata?: object, context?: object }} hookContext
   * @param {{ value?: unknown, reason?: string, errorCode?: string, flagMetadata?: object }} evaluationDetails
   * @returns {void}
   */
  finally (hookContext, evaluationDetails) {
    const writer = this._writer
    if (!writer) return

    // Cheap scalar extraction — no JSON.stringify, no map lookup, no aggregation
    const flagKey = hookContext.flagKey

    // Absent variant (undefined/null/empty) means runtime_default
    const rawValue = evaluationDetails.value
    const variant = rawValue !== undefined && rawValue !== null ? String(rawValue) : ''

    const reason = (evaluationDetails.reason ?? 'unknown').toLowerCase()

    // allocationKey from flagMetadata (camelCase per eval-metrics-hook.js convention)
    const allocationKey = hookContext.flagMetadata?.allocationKey ?? ''

    const targetingKey = hookContext.context?.targetingKey ?? ''

    // Prefer eval-time stamped by the provider at eval entry.
    // Falls back to hook-fire time when absent (non-Datadog provider, or old provider version).
    const evalTimeMs = hookContext.flagMetadata?.['dd.eval.timestamp_ms'] ?? Date.now()

    // Shallow reference to the context attrs — owned by the SDK; safe to read off hot path
    const attrs = hookContext.context ?? {}

    writer.enqueue({ flagKey, variant, reason, allocationKey, targetingKey, evalTimeMs, attrs })
  }
}

module.exports = FlagEvalEVPHook
