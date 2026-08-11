'use strict'

/**
 * FlagEvalEVPHook is a Finally-stage OpenFeature hook that extracts evaluation
 * scalars and hands the event to the FlagEvaluationsWriter for enqueue.
 *
 * The extraction work in this file is genuinely cheap (a handful of scalar reads).
 * The dominant inline cost lives in `FlagEvaluationsWriter.enqueue`, which prunes
 * the caller's evaluation context (flatten + sort + rebuild) synchronously on the
 * evaluation thread — see the class-level comment on that file for why the prune
 * must run inline. Aggregation, canonical keying, and payload encoding are all
 * deferred off this call stack.
 *
 * The existing FlagEvalMetricsHook (OTel feature_flag.evaluations) is untouched —
 * this hook is registered IN ADDITION to it, not as a replacement.
 */
class FlagEvalEVPHook {
  /** @type {import('./flag-evaluations')} */
  _writer

  /**
   * @param {import('./flag-evaluations')} writer - FlagEvaluationsWriter instance
   */
  constructor (writer) {
    this._writer = writer
  }

  /**
   * Called by the OpenFeature SDK after every flag evaluation (success, error, or default).
   * Using the `finally` stage (not `after`) ensures error and default paths are covered.
   *
   * Inline work performed here:
   *   - Scalar field extraction from hookContext + evaluationDetails
   *   - Read evaluationDetails.flagMetadata for allocationKey and eval-time stamp
   *   - Non-blocking enqueue to the writer (which prunes the context inline; see
   *     FlagEvaluationsWriter for the cost/rationale)
   *
   * No canonical keying, no map aggregation, no JSON encoding, no HTTP: all deferred.
   *
   * Field sources mirror flag-eval-metrics-hook.js (the OTel hook) exactly:
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

    const flagKey = hookContext.flagKey

    // Variant = the OpenFeature variant (NOT the evaluated value). Absent variant
    // (no matched allocation) signals runtime_default. Matches the OTel hook.
    const variant = evaluationDetails.variant ?? ''

    // allocationKey from evaluationDetails.flagMetadata (camelCase), the same source
    // flag-eval-metrics-hook.js reads for feature_flag.result.allocation_key.
    const flagMetadata = evaluationDetails.flagMetadata
    const allocationKey = flagMetadata?.allocationKey ?? ''

    const targetingKey = hookContext.context?.targetingKey ?? ''

    // Prefer an eval-time stamp from flag metadata when a provider supplies one.
    // The bundled flagging-core provider stamps evaluation start time under
    // the reserved key `__dd_eval_timestamp_ms`; fall back to hook-fire time only when
    // the metadata value is absent or not a finite number, matching the provider's own
    // Number.isFinite fallback so first/last_evaluation stay accurate.
    const metadataTimestamp = flagMetadata?.__dd_eval_timestamp_ms
    const evalTimeMs = Number.isFinite(metadataTimestamp) ? metadataTimestamp : Date.now()
    const errorMessage = evaluationDetails.errorMessage ?? evaluationDetails.errorCode ?? ''

    // Passed to the writer for inline pruning (see FlagEvaluationsWriter.enqueue).
    // The SDK produces a fresh shallow-merged object per evaluation, so the top-level
    // identity is stable, but nested values share references with caller state — which
    // is exactly why the writer prunes inline rather than deferring the flatten.
    const attrs = hookContext.context ?? {}

    writer.enqueue({ flagKey, variant, allocationKey, targetingKey, errorMessage, evalTimeMs, attrs })
  }
}

module.exports = FlagEvalEVPHook
