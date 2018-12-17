'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const DatadogSpanContext = require('../span_context')

const traceKey = 'dd.trace_id'
const spanKey = 'dd.span_id'

class LogPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext.traceId.toString()
    carrier[spanKey] = spanContext.spanId.toString()
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) {
      return null
    }

    const spanContext = new DatadogSpanContext({
      traceId: new Uint64BE(carrier[traceKey], 10),
      spanId: new Uint64BE(carrier[spanKey], 10)
    })

    return spanContext
  }
}

module.exports = LogPropagator
