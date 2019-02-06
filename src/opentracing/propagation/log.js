'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const DatadogSpanContext = require('../span_context')

class LogPropagator {
  inject (spanContext, carrier) {
    if (!carrier) return

    carrier.dd = {
      trace_id: spanContext.toTraceId(),
      span_id: spanContext.toSpanId()
    }
  }

  extract (carrier) {
    if (!carrier || !carrier.dd || !carrier.dd.trace_id || !carrier.dd.span_id) {
      return null
    }

    const spanContext = new DatadogSpanContext({
      traceId: new Uint64BE(carrier.dd.trace_id, 10),
      spanId: new Uint64BE(carrier.dd.span_id, 10)
    })

    return spanContext
  }
}

module.exports = LogPropagator
