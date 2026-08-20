'use strict'

const PrioritySampler = require('../priority_sampler')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const { SAMPLING_MECHANISM_DEFAULT, TRACE_SOURCE_PROPAGATION_KEY } = require('../constants')
const eventWriter = require('../opentracing/event-writer')
const { addTraceSourceTag, hasTraceSourcePropagationTag } = require('./tracesource')
const { getProductRateLimiter } = require('./product')

class TraceSourcePrioritySampler extends PrioritySampler {
  /**
   * @override
   */
  configure (env, sampler, config) {
    // rules not supported
    this._env = env
    this._limiter = getProductRateLimiter(config)
  }

  /**
   * @override
   * @returns {import('../priority_sampler').SamplingPriority|undefined}
   */
  _getPriorityFromTags (tags, context) {
    if (Object.hasOwn(tags, MANUAL_KEEP) &&
      tags[MANUAL_KEEP] !== false &&
      hasTraceSourcePropagationTag(context._trace.tags)
    ) {
      return USER_KEEP
    }
  }

  /**
   * @override
   */
  _getPriorityFromAuto (span) {
    const context = this._getContext(span)

    eventWriter.setSamplingMechanism(context, SAMPLING_MECHANISM_DEFAULT)

    if (hasTraceSourcePropagationTag(context._trace.tags)) {
      return USER_KEEP
    }

    return this._isSampledByRateLimit(context) ? AUTO_KEEP : AUTO_REJECT
  }

  /**
   * @override
   */
  setPriority (span, samplingPriority, product) {
    super.setPriority(span, samplingPriority, product)

    const context = this._getContext(span)
    const tags = context?._trace?.tags
    if (!tags || !product) return

    const traceSourceTags = { [TRACE_SOURCE_PROPAGATION_KEY]: tags[TRACE_SOURCE_PROPAGATION_KEY] }
    addTraceSourceTag(traceSourceTags, product)
    eventWriter.setTraceTag(context, TRACE_SOURCE_PROPAGATION_KEY, traceSourceTags[TRACE_SOURCE_PROPAGATION_KEY])
  }
}

module.exports = TraceSourcePrioritySampler
