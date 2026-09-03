'use strict'

const api = require('@opentelemetry/api')
const { AUTO_KEEP } = require('../../../../ext/priority')
const { updateOtelTraceState } = require('../otel_sampling')
const DatadogSpanContext = require('../opentracing/span_context')
const TraceState = require('../opentracing/propagation/tracestate')
const id = require('../id')

function newContext () {
  const spanId = id()
  return new DatadogSpanContext({
    traceId: spanId,
    spanId,
  })
}

class SpanContext {
  constructor (context) {
    if (!(context instanceof DatadogSpanContext)) {
      context = context
        ? new DatadogSpanContext(context)
        : newContext()
    }
    this._ddContext = context
  }

  get traceId () {
    return this._ddContext.toTraceId(true)
  }

  get spanId () {
    return this._ddContext.toSpanId(true)
  }

  get traceFlags () {
    this._ddContext._ensureSamplingPriority()
    return this._ddContext._sampling.priority >= AUTO_KEEP ? 1 : 0
  }

  get traceState () {
    this._ddContext._ensureSamplingPriority()
    const traceState = TraceState.fromString(this._ddContext._tracestate?.toString())
    updateOtelTraceState(this._ddContext, traceState)
    return api.createTraceState(traceState.toString())
  }
}

module.exports = SpanContext
