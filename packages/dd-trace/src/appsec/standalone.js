'use strict'

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')
const { APM_TRACING_ENABLED_KEY, APPSEC_PROPAGATION_KEY, SAMPLING_MECHANISM_APPSEC } = require('../constants')

const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { PrioritySampler, hasOwn } = require('../priority_sampler')
const RateLimiter = require('../rate_limiter')

let enabled

class StandAloneAsmPrioritySampler extends PrioritySampler {
  constructor (env) {
    super(env, { sampleRate: 0, rateLimit: 0, rules: [] })

    // let some regular APM traces go through, 1 per minute to keep alive the service
    this._limiter = new RateLimiter(1, 'minute')
  }

  configure (env, config) {
    // rules not supported
    this._env = env
  }

  _getPriorityFromTags (tags, context) {
    if (hasOwn(tags, MANUAL_KEEP) &&
      tags[MANUAL_KEEP] !== false &&
      hasOwn(context._trace.tags, APPSEC_PROPAGATION_KEY)
    ) {
      context._sampling.mechanism = SAMPLING_MECHANISM_APPSEC
      return USER_KEEP
    }
  }

  _getPriorityFromAuto (span) {
    const context = this._getContext(span)

    context._sampling.mechanism = SAMPLING_MECHANISM_APPSEC

    if (hasOwn(context._trace.tags, APPSEC_PROPAGATION_KEY)) {
      return USER_KEEP
    }

    return this._isSampledByRateLimit(context) ? AUTO_KEEP : AUTO_REJECT
  }
}

function onSpanStart ({ span, fields }) {
  const { parent } = fields
  const tags = span.context()._tags

  if (!parent || parent._isRemote) {
    tags[APM_TRACING_ENABLED_KEY] = 0
  }

  // reset upstream priority if _dd.p.appsec is not found
  if (parent?._isRemote && !parent._trace.tags[APPSEC_PROPAGATION_KEY]) {
    span._spanContext._sampling = {}
  }
}

function sample (span) {
  if (enabled) {
    span.context()._trace.tags[APPSEC_PROPAGATION_KEY] = 1

    // TODO: reset priority if less than AUTO_KEEP
  }
}

function configure (config, tracer) {
  enabled = config.appsec?.standalone?.enabled

  if (enabled) {
    startCh.subscribe(onSpanStart)
  } else {
    startCh.unsubscribe(onSpanStart)
  }

  const prioritySampler = enabled
    ? new StandAloneAsmPrioritySampler(config.env)
    : new PrioritySampler(config.env, config.sampler)

  tracer.setPrioritySampler(prioritySampler)
}

module.exports = {
  configure,
  sample,
  StandAloneAsmPrioritySampler
}

/**
 *

class NoApmTracingSpan extends DatadogSpan {
  _createContext (parent, fields) {
    const spanContext = super._createContext(parent, fields)

    if (!parent || parent._isRemote) {
      spanContext._trace.tags[APM_TRACING_ENABLED_KEY] = 0
    }

    // when injecting the context before a downstream call use remoteSampling priority instead of the sampling priority
    if (parent) {
      spanContext._remoteSampling = parent._isRemote ? parent._sampling : parent._remoteSampling

      if (parent._isRemote) {
        spanContext._sampling = {}
      }
    }

    return spanContext
  }

  _addTags (keyValuePairs) {
    this._resetSamplingPriorityIfNeeded(keyValuePairs)

    return super._addTags(keyValuePairs)
  }

  _resetSamplingPriorityIfNeeded (keyValuePairs) {
    if (!keyValuePairs) return

    const { priority } = this._spanContext._sampling
    if (keyValuePairs[APPSEC_PROPAGATION_KEY] && priority && priority < AUTO_KEEP) {
      this._spanContext._sampling = {}
    }
  }
}

 */
