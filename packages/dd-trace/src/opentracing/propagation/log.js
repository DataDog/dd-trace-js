'use strict'

const id = require('../../id')
const DatadogSpanContext = require('../span_context')

class LogPropagator {
  constructor (config) {
    this._config = config
  }

  inject (spanContext, carrier) {
    if (!carrier) return

    carrier.dd = {}

    if (spanContext) {
      carrier.dd.trace_id = this._config.traceId128BitGenerationEnabled &&
        this._config.traceId128BitLoggingEnabled && spanContext._trace.tags['_dd.p.tid']
        ? spanContext.toTraceId(true)
        : spanContext.toTraceId()

      carrier.dd.span_id = spanContext.toSpanId()
    }

    if (this._config.service) carrier.dd.service = this._config.service
    if (this._config.version) carrier.dd.version = this._config.version
    if (this._config.env) carrier.dd.env = this._config.env
  }

  extract (carrier) {
    if (!carrier || !carrier.dd || !carrier.dd.trace_id || !carrier.dd.span_id) {
      return null
    }

    if (carrier.dd.trace_id.length === 32) {
      const hi = carrier.dd.trace_id.slice(0, 16)
      const lo = carrier.dd.trace_id.slice(16, 32)
      const spanContext = new DatadogSpanContext({
        traceId: id(lo, 16),
        spanId: id(carrier.dd.span_id, 10)
      })

      spanContext._trace.tags['_dd.p.tid'] = hi

      return spanContext
    }
    return new DatadogSpanContext({
      traceId: id(carrier.dd.trace_id, 10),
      spanId: id(carrier.dd.span_id, 10)
    })
  }
}

module.exports = LogPropagator
