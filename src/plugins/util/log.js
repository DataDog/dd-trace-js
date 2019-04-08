'use strict'

const tx = require('./tx')

const log = {
  // Add trace identifiers from the current scope to a log record.
  correlate (tracer, record) {
    const span = tracer.scope().active()
    const clone = {}

    Object.assign(clone, record)

    if (span) {
      clone.dd = {
        trace_id: span.context().toTraceId(),
        span_id: span.context().toSpanId()
      }
    }

    return clone
  }
}

module.exports = Object.assign({}, tx, log)
