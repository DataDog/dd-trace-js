'use strict'

const id = require('../../id')
const DatadogSpanContext = require('../span_context')

class LogPropagator {
  #config

  constructor (config) {
    this.#config = config
  }

  inject (spanContext, carrier) {
    if (!carrier) return

    carrier.dd = {}

    if (spanContext) {
      carrier.dd.trace_id = this.#config.traceId128BitGenerationEnabled &&
        this.#config.traceId128BitLoggingEnabled && spanContext._trace.tags['_dd.p.tid']
        ? spanContext.toTraceId(true)
        : spanContext.toTraceId()

      carrier.dd.span_id = spanContext.toSpanId()
    }

    if (this.#config.service) carrier.dd.service = this.#config.service
    if (this.#config.version) carrier.dd.version = this.#config.version
    if (this.#config.env) carrier.dd.env = this.#config.env
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
        spanId: id(carrier.dd.span_id, 10),
      })

      spanContext._trace.tags['_dd.p.tid'] = hi

      return spanContext
    }
    return new DatadogSpanContext({
      traceId: id(carrier.dd.trace_id, 10),
      spanId: id(carrier.dd.span_id, 10),
    })
  }
}

module.exports = LogPropagator
