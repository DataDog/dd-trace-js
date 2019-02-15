'use strict'

const pick = require('lodash.pick')
const platform = require('../../platform')
const DatadogSpanContext = require('../span_context')
const log = require('../../log')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)
const logKeys = [traceKey, spanKey, samplingKey]

class TextMapPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext.toTraceId()
    carrier[spanKey] = spanContext.toSpanId()

    this._injectSamplingPriority(spanContext, carrier)
    this._injectBaggageItems(spanContext, carrier)

    log.debug(() => `Inject into carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) {
      return null
    }

    const spanContext = new DatadogSpanContext({
      traceId: new platform.Uint64BE(carrier[traceKey], 10),
      spanId: new platform.Uint64BE(carrier[spanKey], 10)
    })

    this._extractBaggageItems(carrier, spanContext)
    this._extractSamplingPriority(carrier, spanContext)

    log.debug(() => `Extract from carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)

    return spanContext
  }

  _injectSamplingPriority (spanContext, carrier) {
    const priority = spanContext._sampling.priority

    if (Number.isInteger(priority)) {
      carrier[samplingKey] = priority.toString()
    }
  }

  _injectBaggageItems (spanContext, carrier) {
    spanContext._baggageItems && Object.keys(spanContext._baggageItems).forEach(key => {
      carrier[baggagePrefix + key] = String(spanContext._baggageItems[key])
    })
  }

  _extractBaggageItems (carrier, spanContext) {
    Object.keys(carrier).forEach(key => {
      const match = key.match(baggageExpr)

      if (match) {
        spanContext._baggageItems[match[1]] = carrier[key]
      }
    })
  }

  _extractSamplingPriority (carrier, spanContext) {
    const priority = parseInt(carrier[samplingKey], 10)

    if (Number.isInteger(priority)) {
      spanContext._sampling.priority = parseInt(carrier[samplingKey], 10)
    }
  }
}

module.exports = TextMapPropagator
