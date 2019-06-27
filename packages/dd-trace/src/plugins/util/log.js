'use strict'

const tx = require('./tx')

const log = {
  // Add trace identifiers from the current scope to a log record.
  correlate (tracer, record) {
    const span = tracer.scope().active()

    if (!span) return record

    return Object.assign({}, record, {
      dd: {
        trace_id: span.context().toTraceId(),
        span_id: span.context().toSpanId()
      }
    })
  }
}

module.exports = Object.assign({}, tx, log)
