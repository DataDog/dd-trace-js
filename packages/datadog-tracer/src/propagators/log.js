'use strict'

class LogPropagator {
  inject (span, carrier) {
    if (!carrier) return

    carrier.dd = {}

    if (span) {
      carrier.dd.trace_id = span.trace.traceId.toString()
      carrier.dd.span_id = span.spanId.toString()
    }

    const config = span.tracer.config

    if (config.service) carrier.dd.service = config.service
    if (config.version) carrier.dd.version = config.version
    if (config.env) carrier.dd.env = config.env
  }

  extract (carrier) {
    return null // extraction not supported for logs
  }
}

module.exports = { LogPropagator }
