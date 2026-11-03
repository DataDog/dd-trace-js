'use strict'

const { MAX_EVALUATION_TIMESTAMP_MS } = require('../constants/constants')
const { snapshotEvaluationContext } = require('./flag-evaluation-context')
const {
  recordContextTruncated, recordDropped, recordHookError, recordTargetingKeyOmitted,
} = require('./flag-evaluation-telemetry')
const FlagEvaluationsWriter = require('./flag-evaluations')
const { setExposureDeliveryStrategy } = require('./util')

/** Captures terminal SDK results; the writer owns deferred aggregation and delivery. */
class FlagEvalEVPHook {
  /** @type {FlagEvaluationsWriter} */
  #writer
  #closed = false
  #stopDeliveryStrategy
  #dependencyTelemetrySidecar

  /**
   * The provider only constructs this hook when evaluation counts are enabled.
   *
   * @param {import('../../config/config-base')} config
   * @param {{
   *   takeDependencyEvaluations: (metadata: object | undefined) => Array<{
   *     flagKey: string,
   *     details: import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>
   *   }>
   * }} dependencyTelemetrySidecar
   */
  constructor (config, dependencyTelemetrySidecar) {
    const writer = new FlagEvaluationsWriter(config)
    this.#writer = writer
    this.#dependencyTelemetrySidecar = dependencyTelemetrySidecar
    this.#stopDeliveryStrategy = setExposureDeliveryStrategy(config, (enabled, route) => {
      if (this.#closed) return
      writer.setEnabled(enabled, route)
    })
  }

  /**
   * Successful prerequisite evaluations are available before later application hooks run.
   * Consume them here so a later hook failure cannot discard their telemetry.
   *
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  after (hookContext, evaluationDetails) {
    this.#captureDependencies(hookContext, evaluationDetails)
  }

  /**
   * Provider hooks run in finally even when the SDK short-circuits before resolution.
   * Consent belongs to the captured result, never the provider's current configuration.
   *
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  finally (hookContext, evaluationDetails) {
    // Error-coded provider results skip after, but retain the provider metadata
    // on the final root details. Taking the sidecar batch is idempotent.
    this.#captureDependencies(hookContext, evaluationDetails)
    this.#capture(hookContext.flagKey, hookContext, evaluationDetails)
  }

  /**
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   */
  #captureDependencies (hookContext, evaluationDetails) {
    const dependencies = this.#dependencyTelemetrySidecar?.takeDependencyEvaluations(
      evaluationDetails?.flagMetadata
    ) ?? []
    for (const dependency of dependencies) {
      this.#capture(dependency.flagKey, hookContext, dependency.details)
    }
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
    this.#stopDeliveryStrategy?.()
    this.#writer.destroy()
  }
}

module.exports = FlagEvalEVPHook
