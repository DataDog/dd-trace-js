'use strict'

const id = require('../../id')
const DatadogSpanContext = require('../span_context')

class LogPropagator {
  constructor (config) {
    this._config = config
  }

  /**
   * @param {DatadogSpanContext | null | undefined} spanContext
   * @param {Record<string, unknown>} [carrier]
   * @returns {Record<string, unknown> | undefined}
   */
  inject (spanContext, carrier) {
    if (carrier === null) return

    const dd = {}
    let hasField = false

    if (spanContext) {
      dd.trace_id = this._config.traceId128BitGenerationEnabled &&
        this._config.traceId128BitLoggingEnabled && spanContext._trace.tags['_dd.p.tid']
        ? spanContext.toTraceId(true)
        : spanContext.toTraceId()
      dd.span_id = spanContext.toSpanId()
      hasField = true
    }
    if (this._config.service) {
      dd.service = this._config.service
      hasField = true
    }
    if (this._config.version) {
      dd.version = this._config.version
      hasField = true
    }
    if (this._config.env) {
      dd.env = this._config.env
      hasField = true
    }

    if (!hasField) return

    carrier ??= {}
    carrier.dd = dd
    return carrier
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
