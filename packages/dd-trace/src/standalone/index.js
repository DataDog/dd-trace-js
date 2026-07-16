'use strict'

const { channel } = require('dc-polyfill')
const { USER_KEEP } = require('../../../../ext/priority')
const { APM_TRACING_ENABLED_KEY } = require('../constants')
const TraceSourcePrioritySampler = require('./tracesource_priority_sampler')
const { hasTraceSourcePropagationTag } = require('./tracesource')

const startCh = channel('dd-trace:span:start')
const extractCh = channel('dd-trace:span:extract')

/**
 * @param {import('../config/config-base')} config - Tracer configuration
 */
function configure (config) {
  if (startCh.hasSubscribers) startCh.unsubscribe(onSpanStart)
  if (extractCh.hasSubscribers) extractCh.unsubscribe(onSpanExtract)

  if (config.apmTracingEnabled !== false) return

  startCh.subscribe(onSpanStart)
  extractCh.subscribe(onSpanExtract)

  return new TraceSourcePrioritySampler(config.env)
}

function onSpanStart ({ span, fields }) {
  const context = span.context?.()
  if (!context) return

  const { parent } = fields
  if (!parent || parent._isRemote) {
    context.setTag(APM_TRACING_ENABLED_KEY, 0)
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
  hasTraceSourcePropagationTag,
}
