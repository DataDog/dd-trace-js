'use strict'

const { channel } = require('dc-polyfill')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const { MANUAL_KEEP } = require('../../../../ext/tags')
const { PrioritySampler, hasOwn } = require('../priority_sampler')
const RateLimiter = require('../rate_limiter')
const TraceState = require('../opentracing/propagation/tracestate')
const {
  APM_TRACING_ENABLED_KEY,
  APPSEC_PROPAGATION_KEY,
  SAMPLING_MECHANISM_APPSEC,
  DECISION_MAKER_KEY
} = require('../constants')

const startCh = channel('dd-trace:span:start')
const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

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
  const tags = span.context?.()?._tags
  if (!tags) return

  const { parent } = fields
  if (!parent || parent._isRemote) {
    tags[APM_TRACING_ENABLED_KEY] = 0
  }
}

function onSpanInject ({ spanContext, carrier }) {
  // do not inject trace and sampling if there is no appsec event
  if (!hasOwn(spanContext._trace.tags, APPSEC_PROPAGATION_KEY)) {
    for (const key in carrier) {
      const lKey = key.toLowerCase()
      if (lKey.startsWith('x-datadog')) {
        delete carrier[key]
      } else if (lKey === 'tracestate') {
        const tracestate = TraceState.fromString(carrier[key])
        tracestate.forVendor('dd', state => state.clear())
        carrier[key] = tracestate.toString()
      }
    }
  }
}

function onSpanExtract ({ spanContext, carrier }) {
  // reset upstream priority if _dd.p.appsec is not found
  if (!hasOwn(spanContext._trace.tags, APPSEC_PROPAGATION_KEY)) {
    resetSampling(spanContext)
  } else if (spanContext._sampling.priority !== USER_KEEP) {
    spanContext._sampling.priority = USER_KEEP
  }
}

function sample (span) {
  const spanContext = span.context?.()
  if (enabled && spanContext._trace?.tags) {
    spanContext._trace.tags[APPSEC_PROPAGATION_KEY] = '1'

    // TODO: ask. can we reset here sampling like this?
    // all spans in the trace are sharing the parent sampling object so...
    // should we get prio from StandAloneAsmPrioritySampler._getPriorityFromTags?
    // but then we should set dm too...
    if (spanContext._sampling?.priority < AUTO_KEEP) {
      resetSampling(spanContext)
    }
  }
}

function resetSampling (spanContext) {
  spanContext._sampling.priority = undefined
  delete spanContext._trace.tags[DECISION_MAKER_KEY]
}

function configure (config) {
  const configChanged = enabled !== config.appsec?.standalone?.enabled
  if (!configChanged) return

  enabled = config.appsec?.standalone?.enabled

  let prioritySampler
  if (enabled) {
    startCh.subscribe(onSpanStart)
    injectCh.subscribe(onSpanInject)
    extractCh.subscribe(onSpanExtract)

    prioritySampler = new StandAloneAsmPrioritySampler(config.env)
  } else {
    startCh.unsubscribe(onSpanStart)
    injectCh.unsubscribe(onSpanInject)
    extractCh.unsubscribe(onSpanExtract)
  }

  return prioritySampler
}

module.exports = {
  configure,
  sample,
  StandAloneAsmPrioritySampler
}
