'use strict'

const { channel } = require('dc-polyfill')
const { SpanEnrichmentState } = require('./span-enrichment')
const log = require('../log')

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
 * - `ffe_defaults`: JSON dict of flag_key → "coded-default: <value>"
 */
class SpanEnrichmentHook {
  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('./flagging_provider')} provider - The flagging provider instance
   */
  constructor (tracer, provider) {
    this._tracer = tracer
    this._provider = provider

    /** @type {WeakMap<object, SpanEnrichmentState>} */
    this._spanStates = new WeakMap()

    // Subscribe to span finish channel to apply tags before export
    this._onSpanFinish = this._onSpanFinish.bind(this)
    finishCh.subscribe(this._onSpanFinish)
  }

  /**
   * Called by the OpenFeature SDK after every flag evaluation (success or error).
   *
   * @param {{ flagKey: string, evaluationContext?: { targetingKey?: string } }} hookContext
   *   - Hook context containing the flag key and evaluation context
   * @param {{ flagMetadata?: { serialId?: number, doLog?: boolean }, reason?: string, value?: any }} evaluationDetails
   *   - Full evaluation details including flag metadata
   * @returns {void}
   */
  finally (hookContext, evaluationDetails) {
    try {
      const rootSpan = this._getRootSpan()
      if (!rootSpan) return

      const state = this._getOrCreateState(rootSpan)
      const { flagKey, evaluationContext } = hookContext || {}
      const { flagMetadata, reason, value } = evaluationDetails || {}

      // Extract serial ID and doLog from flagMetadata (set by provider)
      const serialId = flagMetadata?.serialId
      const doLog = flagMetadata?.doLog ?? false
      const targetingKey = evaluationContext?.targetingKey

      if (serialId != null) {
        // Flag found in UFC - add serial ID
        state.addSerialId(serialId)

        // If doLog is true and we have a targeting key, track the subject
        if (doLog && targetingKey) {
          state.addSubject(targetingKey, serialId)
        }
      } else if (reason === 'DEFAULT') {
        // Flag not found in UFC, fell back to default value
        state.addDefault(flagKey, value)
      }
    } catch (err) {
      log.warn('SpanEnrichmentHook: error in finally hook: %s', err.message)
    }
  }

  /**
   * Get the root span for the current trace context.
   *
   * @returns {object|null} The root span, or null if no active span
   * @private
   */
  _getRootSpan () {
    const span = this._tracer.scope().active()
    if (!span) return null

    // Walk up the parent chain to find the root span
    const context = span.context()
    const trace = context._trace

    if (!trace || !trace.started) return span

    // Find the span with no parent (root span)
    for (const s of trace.started) {
      const ctx = s.context()
      if (!ctx._parentId) {
        return s
      }
    }

    // Fallback to current span if no root found
    return span
  }

  /**
   * Get or create enrichment state for a span.
   *
   * @param {object} span - The span to get state for
   * @returns {SpanEnrichmentState} The enrichment state
   * @private
   */
  _getOrCreateState (span) {
    let state = this._spanStates.get(span)
    if (!state) {
      state = new SpanEnrichmentState()
      this._spanStates.set(span, state)
    }
    return state
  }

  /**
   * Handler for span finish channel. Applies accumulated tags to the span.
   *
   * @param {object} span - The span that is finishing
   * @private
   */
  _onSpanFinish (span) {
    const state = this._spanStates.get(span)
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
      this._spanStates.delete(span)
    }
  }

  /**
   * Cleanup method to unsubscribe from channels.
   * Should be called when the provider is shut down.
   */
  destroy () {
    finishCh.unsubscribe(this._onSpanFinish)
  }
}

module.exports = SpanEnrichmentHook
