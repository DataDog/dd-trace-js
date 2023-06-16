'use strict'

const api = require('@opentelemetry/api')
const { AUTO_KEEP } = require('../../../../ext/priority')
const DatadogSpanContext = require('../opentracing/span_context')
const id = require('../id')

function newContext () {
  const spanId = id()
  return new DatadogSpanContext({
    traceId: spanId,
    spanId
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
    return this._ddContext._traceId.toString(16)
  }

  get spanId () {
    return this._ddContext._spanId.toString(16)
  }

  get traceFlags () {
    return this._ddContext._sampling.priority >= AUTO_KEEP ? 1 : 0
  }

  get traceState () {
    const ts = this._ddContext._tracestate
    return api.createTraceState(ts ? ts.toString() : '')
  }
}

module.exports = SpanContext
