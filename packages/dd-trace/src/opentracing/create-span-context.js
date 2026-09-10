'use strict'

const { performance } = require('node:perf_hooks')

const id = require('../id')
const SpanContext = require('./span_context')

const dateNow = Date.now
const now = performance.now.bind(performance)

/**
 * @param {import('../config') | undefined} config
 * @param {SpanContext | null | undefined} parent
 * @param {SpanContext | undefined} context
 * @param {boolean | undefined} traceId128BitGenerationEnabled
 * @param {typeof SpanContext} [Context]
 * @returns {SpanContext}
 */
function createSpanContext (
  config,
  parent,
  context,
  traceId128BitGenerationEnabled,
  Context = SpanContext
) {
  let spanContext
  let startTime

  let baggage
  const propagationBehavior = config?.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT ?? 'continue'
  if (parent && parent._isRemote && propagationBehavior !== 'continue') {
    baggage = parent._baggageItems
    parent = null
  }

  if (context) {
    spanContext = context
    if (!spanContext._trace.startTime) {
      startTime = dateNow()
    }
  } else if (parent) {
    spanContext = new Context({
      traceId: parent._traceId,
      spanId: id(),
      parentId: parent._spanId,
      sampling: parent._sampling,
      baggageItems: { ...parent._baggageItems },
      trace: parent._trace,
      tracestate: parent._tracestate,
    })

    if (!spanContext._trace.startTime) {
      startTime = dateNow()
    }
  } else {
    const spanId = id()
    startTime = dateNow()
    spanContext = new Context({
      traceId: spanId,
      spanId,
    })
    spanContext._trace.startTime = startTime

    if (traceId128BitGenerationEnabled) {
      spanContext._trace.tags['_dd.p.tid'] = Math.floor(startTime / 1000).toString(16)
        .padStart(8, '0')
        .padEnd(16, '0')
    }

    if (propagationBehavior === 'restart') {
      spanContext._baggageItems = baggage ?? {}
    }
  }

  spanContext._trace.ticks ||= now()
  if (startTime) {
    spanContext._trace.startTime = startTime
  }
  spanContext._isRemote = false

  return spanContext
}

module.exports = createSpanContext
