'use strict'

const { W3CTraceContextPropagator } = require('../../../../vendor/dist/@opentelemetry/core')

const getConfig = require('../config')
const id = require('../id')
const TextMapPropagator = require('../opentracing/propagation/text_map')
const { getApi } = require('./api')
const SpanContext = require('./span_context')

const TRACE_ID_128 = '_dd.p.tid'

class DatadogPropagator {
  constructor (config = getConfig()) {
    this._agentless = config.experimental?.exporter === 'agentless'
    this._datadog = new TextMapPropagator({
      ...config,
      DD_TRACE_PROPAGATION_EXTRACT_FIRST: true,
    })
    this._w3c = new W3CTraceContextPropagator()
  }

  inject (context, carrier, setter) {
    const spanContext = getApi().trace.getSpanContext(context)
    if (!spanContext?._ddContext) {
      this._w3c.inject(context, carrier, setter)
      return
    }

    const headers = {}
    this._datadog.inject(spanContext._ddContext, headers)
    for (const [key, value] of Object.entries(headers)) {
      setter.set(carrier, key, value)
    }
  }

  extract (context, carrier, getter) {
    const headers = {}
    for (const key of getter.keys(carrier)) {
      headers[key] = getter.get(carrier, key)
    }

    const extracted = this._datadog.extract(headers)
    if (!extracted) return this._w3c.extract(context, carrier, getter)

    // The agentless intake accepts 64-bit trace IDs only. Truncate when the
    // remote context is created so separately executed Vercel functions use
    // one consistent ID instead of truncating independent chunks at export.
    if (this._agentless) {
      extracted._traceId = id(extracted._traceId.toString(16).slice(-16), 16)
      delete extracted._trace.tags[TRACE_ID_128]
    }

    return getApi().trace.setSpanContext(context, new SpanContext(extracted))
  }

  fields () {
    return [
      'traceparent',
      'tracestate',
      'x-datadog-trace-id',
      'x-datadog-parent-id',
      'x-datadog-sampling-priority',
      'x-datadog-origin',
      'x-datadog-tags',
    ]
  }
}

module.exports = DatadogPropagator
