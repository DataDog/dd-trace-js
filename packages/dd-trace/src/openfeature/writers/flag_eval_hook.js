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
   *   - Read evaluationDetails.flagMetadata for allocationKey and eval-time stamp
   *   - Non-blocking enqueue to the writer's aggregation loop
   *
   * Field sources mirror eval-metrics-hook.js (the OTel hook) exactly:
   * variant and flagMetadata both come from evaluationDetails, not hookContext.
   * The OpenFeature HookContext carries no flagMetadata; only EvaluationDetails does.
   *
   * @param {{ flagKey: string, context?: { targetingKey?: string } }} hookContext
   * @param {{ variant?: string, reason?: string, errorCode?: string, errorMessage?: string,
   *   flagMetadata?: Record<string, string | number | boolean> }} evaluationDetails
   * @returns {void}
   */
  finally (hookContext, evaluationDetails) {
    const writer = this._writer
    if (!writer) return

    // Cheap scalar extraction — no JSON.stringify, no map lookup, no aggregation
    const flagKey = hookContext.flagKey

    // Variant = the OpenFeature variant (NOT the evaluated value). Absent variant
    // (no matched allocation) signals runtime_default. Matches the OTel hook.
    const variant = evaluationDetails.variant ?? ''

    // allocationKey from evaluationDetails.flagMetadata (camelCase), the same source
    // eval-metrics-hook.js reads for feature_flag.result.allocation_key.
    const flagMetadata = evaluationDetails.flagMetadata
    const allocationKey = flagMetadata?.allocationKey ?? ''

    const targetingKey = hookContext.context?.targetingKey ?? ''

    // Prefer an eval-time stamp from flag metadata when a provider supplies one;
    // the Datadog Node evaluator does not currently stamp it, so this falls back to
    // hook-fire time, which still populates first/last_evaluation bounds correctly.
    const evalTimeMs = flagMetadata?.['dd.eval.timestamp_ms'] ?? Date.now()
    const errorMessage = evaluationDetails.errorMessage ?? evaluationDetails.errorCode ?? ''

    // Shallow reference to the context attrs — owned by the SDK; safe to read off hot path
    const attrs = hookContext.context ?? {}

    writer.enqueue({ flagKey, variant, allocationKey, targetingKey, errorMessage, evalTimeMs, attrs })
  }
}

module.exports = FlagEvalEVPHook
