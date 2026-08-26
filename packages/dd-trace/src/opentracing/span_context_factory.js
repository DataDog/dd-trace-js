'use strict'

const { performance } = require('perf_hooks')
const id = require('../id')
const SpanContext = require('./span_context')

const dateNow = Date.now
const now = performance.now.bind(performance)
const materialized = Symbol('datadog.span_context.materialized')

/**
 * Allocate a local span context independently from a span.
 *
 * Keeping allocation here lets correlation and propagation reserve their IDs before the
 * tracing stage decides whether to materialize a span. The same function is used by Span,
 * so a reserved context preserves all existing parent, baggage, restart, and 128-bit ID rules.
 *
 * @param {object} tracer
 * @param {import('./span_context') | null | undefined} parent
 * @param {object} [fields]
 * @param {import('./span_context')} [fields.context]
 * @param {boolean} [fields.traceId128BitGenerationEnabled]
 * @returns {import('./span_context')}
 */
function createSpanContext (tracer, parent, fields = {}) {
  let spanContext
  let startTime
  let baggage

  const propagationBehavior = tracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
  if (parent && parent._isRemote && propagationBehavior !== 'continue') {
    baggage = parent._baggageItems
    parent = null
  }

  if (fields.context) {
    spanContext = fields.context
    if (spanContext[materialized]) {
      throw new Error('A reserved span context can only be materialized once')
    }
    Object.defineProperty(spanContext, materialized, { value: true })
    if (!spanContext._trace.startTime) {
      startTime = dateNow()
    }
  } else if (parent) {
    spanContext = new SpanContext({
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
    spanContext = new SpanContext({
      traceId: spanId,
      spanId,
    })
    spanContext._trace.startTime = startTime

    if (fields.traceId128BitGenerationEnabled) {
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
