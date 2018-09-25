'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const DatadogSpanContext = require('../span_context')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)

class TextMapPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext.traceId.toString()
    carrier[spanKey] = spanContext.spanId.toString()

    this._injectSamplingPriority(spanContext, carrier)
    this._injectBaggageItems(spanContext, carrier)
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) {
      return null
    }

    const spanContext = new DatadogSpanContext({
      traceId: new Uint64BE(carrier[traceKey], 10),
      spanId: new Uint64BE(carrier[spanKey], 10)
    })

    this._extractBaggageItems(carrier, spanContext)
    this._extractSamplingPriority(carrier, spanContext)

    return spanContext
  }

  _injectSamplingPriority (spanContext, carrier) {
    const priority = spanContext.sampling.priority

    if (Number.isInteger(priority)) {
      carrier[samplingKey] = priority.toString()
    }
  }

  _injectBaggageItems (spanContext, carrier) {
    spanContext.baggageItems && Object.keys(spanContext.baggageItems).forEach(key => {
      carrier[baggagePrefix + key] = String(spanContext.baggageItems[key])
    })
  }

  _extractBaggageItems (carrier, spanContext) {
    Object.keys(carrier).forEach(key => {
      const match = key.match(baggageExpr)

      if (match) {
        spanContext.baggageItems[match[1]] = carrier[key]
      }
    })
  }

  _extractSamplingPriority (carrier, spanContext) {
    const priority = parseInt(carrier[samplingKey], 10)

    if (Number.isInteger(priority)) {
      spanContext.sampling.priority = parseInt(carrier[samplingKey], 10)
    }
  }
}

module.exports = TextMapPropagator
