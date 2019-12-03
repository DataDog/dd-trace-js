'use strict'

const tx = require('./tx')

const log = {
  // Add trace identifiers from the current scope to a log record.
  correlate (tracer, record) {
    const span = tracer.scope().active()

    if (!span) return record

    const carrier = {
      dd: {
        trace_id: span.context().toTraceId(),
        span_id: span.context().toSpanId()
      }
    }

    for (const key in record) {
      carrier[key] = record[key]
    }

    return carrier
  }
}

module.exports = Object.assign({}, tx, log)
