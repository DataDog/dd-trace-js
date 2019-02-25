'use strict'

const pick = require('lodash.pick')
const platform = require('../../platform')
const DatadogSpanContext = require('../span_context')
const log = require('../../log')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)
const logKeys = [traceKey, spanKey, samplingKey, originKey]

class TextMapPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext.toTraceId()
    carrier[spanKey] = spanContext.toSpanId()

    this._injectOrigin(spanContext, carrier)
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

    this._extractOrigin(carrier, spanContext)
    this._extractBaggageItems(carrier, spanContext)
    this._extractSamplingPriority(carrier, spanContext)

    log.debug(() => `Extract from carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)

    return spanContext
  }

  _injectOrigin (spanContext, carrier) {
    const origin = spanContext._trace.origin

    if (origin) {
      carrier[originKey] = origin
    }
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

  _extractOrigin (carrier, spanContext) {
    const origin = carrier[originKey]

    if (typeof carrier[originKey] === 'string') {
      spanContext._trace.origin = origin
    }
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
