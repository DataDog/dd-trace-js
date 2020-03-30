'use strict'

const id = require('../../id')
const DatadogSpanContext = require('../span_context')

class LogPropagator {
  inject (spanContext, carrier) {
    if (!carrier) return

    const tags = spanContext._tags

    carrier.dd = {
      trace_id: spanContext.toTraceId(),
      span_id: spanContext.toSpanId()
    }

    if (tags.service) carrier.dd.service = tags.service
    if (tags.version) carrier.dd.version = tags.version
    if (tags.env) carrier.dd.env = tags.env
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
