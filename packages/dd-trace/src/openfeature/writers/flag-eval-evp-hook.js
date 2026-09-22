'use strict'

const { snapshotEvaluationContext } = require('./flag-evaluation-context')
const { recordContextTruncated, recordDropped, recordHookError } = require('./flag-evaluation-telemetry')
const FlagEvaluationsWriter = require('./flag-evaluations')
const { setExposureDeliveryStrategy } = require('./util')

/** Captures terminal SDK results; the writer owns deferred aggregation and delivery. */
class FlagEvalEVPHook {
  /** @type {FlagEvaluationsWriter | undefined} */
  #writer
  #ready = false
  #closed = false

  /** @param {import('../../config/config-base')} config */
  constructor (config) {
    if (config.featureFlags.DD_FEATURE_FLAGS_EVALUATION_COUNTS_ENABLED === false) return

    const writer = new FlagEvaluationsWriter(config)
    this.#writer = writer
    setExposureDeliveryStrategy(config, (enabled, route) => {
      if (this.#closed) return
      writer.setEnabled(enabled, route)
      this.#ready = enabled
    })
  }

  /**
   * Provider hooks run in finally even when the SDK short-circuits before resolution.
   * Consent belongs to the captured result, never the provider's current configuration.
   *
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  finally (hookContext, evaluationDetails) {
    if (!this.#writer) return
    try {
      if (this.#closed || !this.#ready) {
        recordDropped(this.#closed ? 'closed' : 'unavailable')
        return
      }
      if (!this.#writer.hasCapacity()) {
        recordDropped('pre_queue_overflow')
        return
      }

      const metadata = evaluationDetails.flagMetadata
      const consent = metadata?.__dd_observe_full_evaluation_data === true
      const capturedTime = metadata?.__dd_eval_timestamp_ms
      const timestamp = typeof capturedTime === 'number' && Number.isSafeInteger(capturedTime) &&
        Math.abs(capturedTime) <= 8_640_000_000_000_000
        ? capturedTime
        : Date.now()
      const context = hookContext.context
      const targetingKey = context?.targetingKey
      let attrs
      if (consent) {
        const snapshot = snapshotEvaluationContext(context)
        attrs = snapshot.attrs
        for (const reason of snapshot.reasons) recordContextTruncated(reason)
      }

      this.#writer.enqueue({
        flagKey: hookContext.flagKey,
        variant: evaluationDetails.variant,
        allocationKey: typeof metadata?.__dd_allocation_key === 'string' ? metadata.__dd_allocation_key : undefined,
        runtimeDefault: evaluationDetails.variant === undefined,
        errorCode: evaluationDetails.errorCode,
        targetingKey,
        attrs,
        observeFullEvaluationData: consent,
        timestamp,
      })
    } catch {
      recordHookError()
    }
  }

  destroy () {
    if (this.#closed) return
    this.#closed = true
    this.#ready = false
    this.#writer?.destroy()
  }
}

module.exports = FlagEvalEVPHook
