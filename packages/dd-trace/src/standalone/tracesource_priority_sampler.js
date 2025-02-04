'use strict'

const { channel } = require('dc-polyfill')
const { hasOwn } = require('../util')
const PrioritySampler = require('../priority_sampler')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const { SAMPLING_MECHANISM_DEFAULT } = require('../constants')
const { addTraceSourceTag, hasTraceSourcePropagationTag } = require('./tracesource')
const RateLimiter = require('../rate_limiter')

const configureCh = channel('datadog:priority-sampler:configure')

class TraceSourcePrioritySampler extends PrioritySampler {
  constructor (env, opts) {
    super(env, { sampleRate: 0, rateLimit: 0, rules: [] })
  }

  configure (env, config) {
    // rules not supported
    this._env = env
    this._limiter = new RateLimiter(0)

    configureCh.publish({ prioritySampler: this })
  }

  _getPriorityFromTags (tags, context) {
    if (hasOwn(tags, MANUAL_KEEP) &&
      tags[MANUAL_KEEP] !== false &&
      hasTraceSourcePropagationTag(context._trace.tags)
    ) {
      return USER_KEEP
    }
  }

  _getPriorityFromAuto (span) {
    const context = this._getContext(span)

    context._sampling.mechanism = SAMPLING_MECHANISM_DEFAULT

    if (hasTraceSourcePropagationTag(context._trace.tags)) {
      return USER_KEEP
    }

    return this._isSampledByRateLimit(context) ? AUTO_KEEP : AUTO_REJECT
  }

  setPriority (span, samplingPriority, product) {
    super.setPriority(span, samplingPriority, product)

    const context = this._getContext(span)
    addTraceSourceTag(context?._trace?.tags, product)
  }
}

module.exports = TraceSourcePrioritySampler
