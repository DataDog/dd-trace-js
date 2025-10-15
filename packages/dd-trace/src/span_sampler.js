'use strict'

const { USER_KEEP, AUTO_KEEP } = require('../../../ext').priority
const SamplingRule = require('./sampling_rule')

/**
 * Samples individual spans within a trace using span-level rules.
 */
class SpanSampler {
  /**
   * @param {{ spanSamplingRules?: Array<import('./sampling_rule')>|Array<Record<string, unknown>> }} [config]
   */
  constructor ({ spanSamplingRules = [] } = {}) {
    this._rules = spanSamplingRules.map(SamplingRule.from)
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
    for (const span of started) {
      const rule = this.findRule(span)
      if (rule && rule.sample(spanContext)) {
        span.context()._spanSampling = {
          sampleRate: rule.sampleRate,
          maxPerSecond: rule.maxPerSecond
        }
      }
    }
  }
}

module.exports = SpanSampler
