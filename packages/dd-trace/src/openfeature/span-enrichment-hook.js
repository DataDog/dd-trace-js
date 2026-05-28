'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const { SpanEnrichmentState } = require('./span-enrichment')

const finishCh = channel('dd-trace:span:finish')

/**
 * OpenFeature hook that enriches APM spans with feature flag evaluation data.
 *
 * Implements the OpenFeature `finally` hook interface to capture flag evaluations
 * and add span tags for observability. Tags are accumulated during the span's
 * lifetime and applied when the root span finishes.
 *
 * Span tags added:
 * - `ffe_flags_enc`: Base64 delta-varint encoded serial IDs
 * - `ffe_subjects_enc`: JSON dict of SHA256(targeting_key) → encoded serial IDs
 * - `ffe_runtime_defaults`: JSON dict of flag_key → default value string
 */
class SpanEnrichmentHook {
  #tracer
  /** @type {WeakMap<object, SpanEnrichmentState>} */
  #spanStates = new WeakMap()

  /**
   * Handler for span finish channel. Applies accumulated tags to the span.
   * Arrow function to preserve `this` binding for channel subscription.
   *
   * @param {object} span - The span that is finishing
   */
  #onSpanFinish = (span) => {
    const state = this.#spanStates.get(span)
    if (!state || !state.hasData()) return

    try {
      const tags = state.toSpanTags()

      for (const [key, value] of Object.entries(tags)) {
        if (value) {
          span.setTag(key, value)
        }
      }
    } catch (err) {
      log.warn('SpanEnrichmentHook: error applying span tags: %s', err.message)
    } finally {
      this.#spanStates.delete(span)
    }
  }

  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   */
  constructor (tracer) {
    this.#tracer = tracer
    finishCh.subscribe(this.#onSpanFinish)
  }

  /**
   * Called by the OpenFeature SDK after every flag evaluation (success or error).
   *
   * @param {object} hookContext - Hook context containing the flag key and evaluation context
   * @param {string} hookContext.flagKey - The flag key being evaluated
   * @param {object} [hookContext.context] - Evaluation context
   * @param {string} [hookContext.context.targetingKey] - Targeting key
   * @param {object} evaluationDetails - Full evaluation details including flag metadata
   * @param {object} [evaluationDetails.flagMetadata] - Metadata from the provider
   * @param {number} [evaluationDetails.flagMetadata.__dd_split_serial_id] - Serial ID from UFC split
   * @param {boolean} [evaluationDetails.flagMetadata.__dd_do_log] - Whether to log subject
   * @param {string} [evaluationDetails.variant] - Variant key if flag was found in UFC
   * @param {boolean|string|number|object} [evaluationDetails.value] - Evaluated value
   * @returns {void}
   */
  finally (hookContext, evaluationDetails) {
    try {
      const rootSpan = this._getRootSpan()
      if (!rootSpan) return

      const state = this._getOrCreateState(rootSpan)
      const { flagKey, context } = hookContext || {}
      const { flagMetadata, variant, value } = evaluationDetails || {}

      const serialId = flagMetadata?.__dd_split_serial_id
      const doLog = flagMetadata?.__dd_do_log ?? false
      const targetingKey = context?.targetingKey

      if (serialId != null) {
        state.addSerialId(serialId)

        if (doLog && targetingKey) {
          state.addSubject(targetingKey, serialId)
        }
      } else if (variant === undefined) {
        state.addDefault(flagKey, value)
      }
    } catch (err) {
      log.warn('SpanEnrichmentHook: error in finally hook: %s', err.message)
    }
  }

  /**
   * Get the root span for the current trace context.
   * The root span is always the first span in trace.started since spans
   * are added in creation order and the root is created first.
   *
   * @returns {object|null} The root span, or null if no active span
   * @private
   */
  _getRootSpan () {
    const span = this.#tracer.scope().active()
    if (!span) return null

    const trace = span.context()._trace

    return trace?.started?.[0] ?? span
  }

  /**
   * Get or create enrichment state for a span.
   *
   * @param {object} span - The span to get state for
   * @returns {SpanEnrichmentState} The enrichment state
   * @private
   */
  _getOrCreateState (span) {
    let state = this.#spanStates.get(span)
    if (!state) {
      state = new SpanEnrichmentState()
      this.#spanStates.set(span, state)
    }
    return state
  }

  /**
   * Cleanup method to unsubscribe from channels.
   * Should be called when the provider is shut down.
   */
  destroy () {
    finishCh.unsubscribe(this.#onSpanFinish)
  }
}

module.exports = SpanEnrichmentHook
