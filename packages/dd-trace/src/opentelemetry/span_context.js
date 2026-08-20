'use strict'

const api = require('@opentelemetry/api')
const { registerDatadogContext } = require('../opentracing/context-registry')
const DatadogSpanContext = require('../opentracing/span_context')
const id = require('../id')

function newContext () {
  const spanId = id()
  return new DatadogSpanContext({
    traceId: spanId,
    spanId,
  })
}

class SpanContext {
  #datadogContext

  constructor (context) {
    if (!(context instanceof DatadogSpanContext)) {
      context = context
        ? new DatadogSpanContext(context)
        : newContext()
    }
    this.#datadogContext = context
    registerDatadogContext(this, context)
  }

  get traceId () {
    return this.#datadogContext.toTraceId(true)
  }

  get spanId () {
    return this.#datadogContext.toSpanId(true)
  }

  get traceFlags () {
    return this.#datadogContext.toTraceFlags()
  }

  get traceState () {
    return api.createTraceState(this.#datadogContext.toTracestate())
  }
}

module.exports = SpanContext
