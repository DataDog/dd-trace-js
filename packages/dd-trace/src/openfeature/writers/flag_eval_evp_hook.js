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
const FAIL_CLOSED_CONSENT = () => false

class FlagEvalEVPHook {
  /** @type {import('./flag_evaluations')} */
  _writer

  /** @type {() => boolean} */
  _getConsent

  /**
   * @param {import('./flag_evaluations')} writer - FlagEvaluationsWriter instance
   * @param {() => boolean} [getConsent] - Reads the atomic UFC consent snapshot.
   *   Missing accessor fails closed to `false` (no raw PII leaks in tests that
   *   construct this hook directly without a provider).
   */
  constructor (writer, getConsent) {
    this._writer = writer
    this._getConsent = getConsent ?? FAIL_CLOSED_CONSENT
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

    // Prefer an eval-time stamp from flag metadata when a provider supplies one;
    // the Datadog Node evaluator does not currently stamp it, so this falls back to
    // hook-fire time, which still populates first/last_evaluation bounds correctly.
    const evalTimeMs = flagMetadata?.['dd.eval.timestamp_ms'] ?? Date.now()
    const errorMessage = evaluationDetails.errorMessage ?? evaluationDetails.errorCode ?? ''

    // Snapshot consent once, synchronously at hook entry, so a Remote Config
    // update between this hook firing and the writer's flush cannot retroactively
    // change the wire shape of this evaluation. Strict boolean by construction —
    // the provider's snapshot already coerces `=== true`.
    const observeFullEvaluationData = this._getConsent() === true

    // Consent-off: skip capturing the evaluation context entirely. The writer must
    // not receive attrs it will later discard — that would silently push privacy-
    // protected traffic through pruneContext for no downstream use. Concretely, a
    // high-cardinality attribute like `request_id` would then contribute to the
    // aggregation bucket key while producing wire-identical events, exhausting the
    // per-flag cap and pushing consent-off traffic to the degraded tier. Java
    // pilot lesson `concern:consent-off-bucket-keying`.
    //
    // When consent IS on, the SDK produces a fresh shallow-merged object per
    // evaluation, so the top-level identity is stable, but nested values share
    // references with caller state — which is exactly why the writer prunes
    // inline rather than deferring the flatten.
    const attrs = observeFullEvaluationData ? (hookContext.context ?? {}) : {}

    writer.enqueue({
      flagKey,
      variant,
      allocationKey,
      targetingKey,
      errorMessage,
      evalTimeMs,
      attrs,
      observeFullEvaluationData,
    })
  }
}

module.exports = FlagEvalEVPHook
