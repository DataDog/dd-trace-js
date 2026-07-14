'use strict'

const { AUTO_KEEP } = require('../../../../ext/priority')
const DatadogSpanContext = require('../opentracing/span_context')
const id = require('../id')
const { getApi } = require('./api')

const { createTraceState } = getApi()

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
    const ts = this._ddContext._tracestate
    return createTraceState(ts ? ts.toString() : '')
  }
}

module.exports = SpanContext
