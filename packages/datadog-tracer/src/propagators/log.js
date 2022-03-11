'use strict'

class LogPropagator {
  constructor (config) {
    this._config = config
  }

  inject (span, carrier) {
    if (!carrier) return

    carrier.dd = {}

    if (span) {
      carrier.dd.trace_id = span.trace.traceId.toString()
      carrier.dd.span_id = span.spanId.toString()
    }

    if (this._config.service) carrier.dd.service = this._config.service
    if (this._config.version) carrier.dd.version = this._config.version
    if (this._config.env) carrier.dd.env = this._config.env
  }

  extract (carrier) {
    return null // extraction not supported for logs
  }
}

module.exports = { LogPropagator }
