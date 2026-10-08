'use strict'

const { channel } = require('dc-polyfill')

const { DEPENDENCY_EVALUATION_CHANNEL, MAX_EVALUATION_TIMESTAMP_MS } = require('../constants/constants')
const { snapshotEvaluationContext } = require('./flag-evaluation-context')
const {
  recordContextTruncated, recordDropped, recordHookError, recordTargetingKeyOmitted,
} = require('./flag-evaluation-telemetry')
const FlagEvaluationsWriter = require('./flag-evaluations')
const { setExposureDeliveryStrategy } = require('./util')

const dependencyEvaluationCh = channel(DEPENDENCY_EVALUATION_CHANNEL)

/** Captures terminal SDK results; the writer owns deferred aggregation and delivery. */
class FlagEvalEVPHook {
  /** @type {FlagEvaluationsWriter} */
  #writer
  #closed = false
  #stopDeliveryStrategy
  #handleDependencyEvaluation = ({ context, details }) => {
    this.#capture(details.flagKey, { context }, details)
  }

  /**
   * The provider only constructs this hook when evaluation counts are enabled.
   *
   * @param {import('../../config/config-base')} config
   */
  constructor (config) {
    const writer = new FlagEvaluationsWriter(config)
    this.#writer = writer
    this.#stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
      if (this.#closed) return
      writer.setEnabled(enabled, route)
    })
    dependencyEvaluationCh.subscribe(this.#handleDependencyEvaluation)
  }

  /**
   * Provider hooks run in finally even when the SDK short-circuits before resolution.
   * Consent belongs to the captured result, never the provider's current configuration.
   *
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  finally (hookContext, evaluationDetails) {
    this.#capture(hookContext.flagKey, hookContext, evaluationDetails)
  }

  /**
   * Capture a root or prerequisite evaluation with the same privacy and capacity rules.
   *
   * @param {string} flagKey
   * @param {{ context?: import('@openfeature/core').EvaluationContext }} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  #capture (flagKey, hookContext, evaluationDetails) {
    try {
      const unavailableReason = this.#closed ? 'closed' : this.#writer.getUnavailableReason()
      if (unavailableReason !== undefined) {
        recordDropped(unavailableReason)
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
        Math.abs(capturedTime) <= MAX_EVALUATION_TIMESTAMP_MS
        ? capturedTime
        : Date.now()
      const context = hookContext.context
      let targetingKey
      try {
        targetingKey = context?.targetingKey
      } catch {
        // An unreadable identity must not discard an otherwise valid evaluation count.
        recordTargetingKeyOmitted()
      }
      let attrs
      if (consent) {
        let snapshot
        try {
          snapshot = snapshotEvaluationContext(context)
        } catch {
          // Preserve the evaluation count without the failed context. Never log caller-controlled errors.
          recordContextTruncated('snapshot_error')
        }
        if (snapshot !== undefined) {
          attrs = snapshot.attrs
          for (const reason of snapshot.reasons) recordContextTruncated(reason)
        }
      }

      this.#writer.enqueue({
        flagKey,
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
    dependencyEvaluationCh.unsubscribe(this.#handleDependencyEvaluation)
    this.#stopDeliveryStrategy?.()
    this.#writer.destroy()
  }
}

module.exports = FlagEvalEVPHook
