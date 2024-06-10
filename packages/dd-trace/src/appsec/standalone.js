'use strict'

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')
const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

const { APM_TRACING_ENABLED_KEY, APPSEC_PROPAGATION_KEY, SAMPLING_MECHANISM_APPSEC } = require('../constants')

const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { PrioritySampler, hasOwn } = require('../priority_sampler')
const RateLimiter = require('../rate_limiter')

const samplingKey = 'x-datadog-sampling-priority'

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
}

function onSpanInject ({ spanContext, carrier }) {
  // do not inject sampling if there is no appsec event
  if (!hasOwn(spanContext._trace.tags, APPSEC_PROPAGATION_KEY)) {
    delete carrier[samplingKey]
  }
}

function onSpanExtract ({ spanContext, carrier }) {
  // reset upstream priority if _dd.p.appsec is not found
  if (!hasOwn(spanContext._trace.tags, APPSEC_PROPAGATION_KEY)) {
    spanContext._sampling = {}
  }
}

function sample (span) {
  if (enabled) {
    span.context()._trace.tags[APPSEC_PROPAGATION_KEY] = '1'

    // TODO: ask. can we reset here sampling like this?
    // all spans is the trace are sharing the parent sampling object so...
    // should we get prio from StandAloneAsmPrioritySampler._getPriorityFromTags?
    // but then we should set dm too...
    if (span._spanContext._sampling.priority < AUTO_KEEP) {
      span._spanContext._sampling = {}
    }
  }
}

function configure (config, tracer) {
  enabled = config.appsec?.standalone?.enabled

  if (enabled) {
    startCh.subscribe(onSpanStart)
    injectCh.subscribe(onSpanInject)
    extractCh.subscribe(onSpanExtract)
  } else {
    startCh.unsubscribe(onSpanStart)
    injectCh.subscribe(onSpanInject)
    extractCh.unsubscribe(onSpanExtract)
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
