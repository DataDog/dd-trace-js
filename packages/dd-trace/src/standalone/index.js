'use strict'

const { channel } = require('dc-polyfill')
const { USER_KEEP } = require('../../../../ext/priority')
const TraceSourcePrioritySampler = require('./tracesource_priority_sampler')
const { hasTraceSourcePropagationTag } = require('./tracesource')

const extractCh = channel('dd-trace:span:extract')

/**
 * @param {import('../config/config-base')} config - Tracer configuration
 */
function configure (config) {
  if (extractCh.hasSubscribers) extractCh.unsubscribe(onSpanExtract)

  if (config.apmTracingEnabled !== false) return

  extractCh.subscribe(onSpanExtract)

  return new TraceSourcePrioritySampler(config.env)
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
