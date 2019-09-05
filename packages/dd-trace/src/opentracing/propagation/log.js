'use strict'

const id = require('../../id')
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
      traceId: id(carrier.dd.trace_id, 10),
      spanId: id(carrier.dd.span_id, 10)
    })

    return spanContext
  }
}

module.exports = LogPropagator
