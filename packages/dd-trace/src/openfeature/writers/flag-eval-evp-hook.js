'use strict'

/** Captures OpenFeature evaluations for the EVP writer. */
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
   * Captures successful, error, and default evaluations at the OpenFeature `finally` stage.
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

    const variant = evaluationDetails.variant ?? ''

    const flagMetadata = evaluationDetails.flagMetadata
    const allocationKey = flagMetadata?.allocationKey ?? ''

    const targetingKey = hookContext.context?.targetingKey ?? ''

    const metadataTimestamp = flagMetadata?.__dd_eval_timestamp_ms
    const evalTimeMs = Number.isFinite(metadataTimestamp) ? metadataTimestamp : Date.now()
    const errorMessage = evaluationDetails.errorMessage ?? evaluationDetails.errorCode ?? ''

    const attrs = hookContext.context ?? {}

    writer.enqueue({ flagKey, variant, allocationKey, targetingKey, errorMessage, evalTimeMs, attrs })
  }
}

module.exports = FlagEvalEVPHook
