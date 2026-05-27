'use strict'

const { USER_KEEP, AUTO_KEEP } = require('../../../ext').priority
const {
  SPAN_SAMPLING_MECHANISM,
  SPAN_SAMPLING_RULE_RATE,
  SPAN_SAMPLING_MAX_PER_SECOND,
  SAMPLING_MECHANISM_SPAN,
} = require('./constants')
const SamplingRule = require('./sampling_rule')

/**
 * @typedef {{
 *   queueBatchMetrics: (slotIndex: number, metrics: Array<[string, number]>) => void
 * }} NativeSpansQueue
 */

/**
 * Module-scope cache for per-rule span sampling metric arrays.
 * @type {WeakMap<import('./sampling_rule'), Array<[string, number]>>}
 */
const spanSamplingMetricsCache = new WeakMap()

/**
 * Samples individual spans within a trace using span-level rules.
 */
class SpanSampler {
  /**
   * @param {object} [options]
   * @param {Array<import('./sampling_rule')>|Array<Record<string, unknown>>} [options.spanSamplingRules]
   * @param {NativeSpansQueue} [options.nativeSpans]
   */
  constructor ({ spanSamplingRules = [], nativeSpans } = {}) {
    this._rules = spanSamplingRules.map(SamplingRule.from)
    /** @type {NativeSpansQueue|undefined} */
    this._nativeSpans = nativeSpans
  }

  /**
   * Finds the first matching span sampling rule for the given span.
   *
   * @param {import('./opentracing/span')} context
   * @returns {import('./sampling_rule')|undefined}
   */
  findRule (context) {
    for (const rule of this._rules) {
      // Rule is a special object with a .match() property.
      // It has nothing to do with a regular expression.
      // eslint-disable-next-line unicorn/prefer-regexp-test
      if (rule.match(context)) {
        return rule
      }
    }
  }

  /**
   * Applies span sampling to spans in the trace, tagging matching spans with
   * span sampling metadata when appropriate.
   *
   * @param {import('./opentracing/span_context')} spanContext
   * @returns {void}
   */
  sample (spanContext) {
    const decision = spanContext._sampling.priority
    if (decision === USER_KEEP || decision === AUTO_KEEP) return

    const { started } = spanContext._trace
    const nativeSpans = this._nativeSpans
    for (const span of started) {
      const rule = this.findRule(span)
      if (rule && rule.sample(spanContext)) {
        const spanCtx = span.context()
        spanCtx._spanSampling = {
          sampleRate: rule.sampleRate,
          maxPerSecond: rule.maxPerSecond,
        }

        // Queue single-span ingestion metric ops into native storage.
        const slotIndex = spanCtx._slotIndex
        if (nativeSpans && slotIndex !== undefined) {
          let metrics = spanSamplingMetricsCache.get(rule)
          if (!metrics) {
            metrics = [
              [SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN],
              [SPAN_SAMPLING_RULE_RATE, rule.sampleRate],
            ]
            if (Number.isFinite(rule.maxPerSecond)) {
              metrics.push([SPAN_SAMPLING_MAX_PER_SECOND, rule.maxPerSecond])
            }
            spanSamplingMetricsCache.set(rule, metrics)
          }
          nativeSpans.queueBatchMetrics(slotIndex, metrics)
        }
      }
    }
  }
}

module.exports = SpanSampler
