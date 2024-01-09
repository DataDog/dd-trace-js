'use strict'

const { USER_KEEP, AUTO_KEEP } = require('../../../ext').priority
const SamplingRule = require('./sampling_rule')

class SpanSampler {
  constructor ({ spanSamplingRules = [] } = {}) {
    this._rules = spanSamplingRules.map(SamplingRule.from)
  }

  findRule (context) {
    for (const rule of this._rules) {
      if (rule.match(context)) {
        return rule
      }
    }
  }

  sample (spanContext) {
    const decision = spanContext._sampling.priority
    if (decision === USER_KEEP || decision === AUTO_KEEP) return

    const { started } = spanContext._trace
    for (const span of started) {
      const rule = this.findRule(span)
      if (rule && rule.sample()) {
        span.context()._spanSampling = {
          sampleRate: rule.sampleRate,
          maxPerSecond: rule.maxPerSecond
        }
      }
    }
  }
}

module.exports = SpanSampler
