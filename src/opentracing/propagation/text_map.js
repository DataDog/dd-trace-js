'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const Int64BE = require('int64-buffer').Int64BE
const DatadogSpanContext = require('../span_context')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)

class TextMapPropagator {

  constructor (tracer) {
    this._tracer = tracer;
  }

  inject (spanContext, carrier) {
    carrier[traceKey] = new Int64BE(spanContext.traceId.toBuffer()).toString()
    carrier[spanKey] = new Int64BE(spanContext.spanId.toBuffer()).toString()
    if (spanContext.samplingPriority !== undefined) {
      carrier[samplingKey] = spanContext.samplingPriority.toString()
    }

    spanContext.baggageItems && Object.keys(spanContext.baggageItems).forEach(key => {
      carrier[baggagePrefix + key] = String(spanContext.baggageItems[key])
    })
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) {
      return null
    }

    const baggageItems = {}

    Object.keys(carrier).forEach(key => {
      const match = key.match(baggageExpr)

      if (match) {
        baggageItems[match[1]] = carrier[key]
      }
    })

    const samplingPriority = carrier[samplingKey] && parseInt(carrier[samplingKey], 10);
    let sampled;
    if (samplingPriority !== undefined) {
      sampled = samplingPriority > 0;
    } else {
      sampled = this._tracer._isSampled();
    }

    return new DatadogSpanContext({
      traceId: new Uint64BE(carrier[traceKey], 10),
      spanId: new Uint64BE(carrier[spanKey], 10),
      samplingPriority: samplingPriority,
      sampled: sampled,
      baggageItems
    })
  }
}

module.exports = TextMapPropagator
