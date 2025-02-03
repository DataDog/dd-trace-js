'use strict'

const { channel } = require('dc-polyfill')
const PrioritySampler = require('../priority_sampler')
const TraceSourcePrioritySampler = require('./tracesource_priority_sampler')
const { USER_KEEP } = require('../../../../ext/priority')
const TraceState = require('../opentracing/propagation/tracestate')
const { APM_TRACING_ENABLED_KEY } = require('../constants')
const { hasTraceSourcePropagationTag } = require('./tracesource')

const startCh = channel('dd-trace:span:start')
const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

let enabled

function configure (config) {
  const configChanged = enabled !== config.apmTracing.enabled
  if (!configChanged) return

  enabled = config.apmTracing.enabled

  let prioritySampler
  if (enabled) {
    prioritySampler = new PrioritySampler(config.env, config.sampler)

    if (startCh.hasSubscribers) startCh.unsubscribe(onSpanStart)
    if (injectCh.hasSubscribers) injectCh.unsubscribe(onSpanInject)
    if (extractCh.hasSubscribers) extractCh.unsubscribe(onSpanExtract)
  } else {
    prioritySampler = new TraceSourcePrioritySampler(config.env)

    startCh.subscribe(onSpanStart)
    injectCh.subscribe(onSpanInject)
    extractCh.subscribe(onSpanExtract)
  }

  return prioritySampler
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
  if (!spanContext?._trace?.tags || !carrier) return

  // do not inject trace and sampling if there is no _dd.p.ts
  if (!hasTraceSourcePropagationTag(spanContext._trace.tags)) {
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

function onSpanExtract ({ spanContext = {} }) {
  if (!spanContext._trace?.tags || !spanContext._sampling) return

  // reset upstream priority if _dd.p.ts is not found
  if (!hasTraceSourcePropagationTag(spanContext._trace.tags)) {
    spanContext._sampling.priority = undefined
  } else if (spanContext._sampling.priority !== USER_KEEP) {
    spanContext._sampling.priority = USER_KEEP
  }
}

module.exports = {
  configure,
  hasTraceSourcePropagationTag
}
