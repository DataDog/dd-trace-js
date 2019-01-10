'use strict'

const tx = require('./tx')

const log = {
  // Add trace identifiers from the current scope to a log record.
  correlate (tracer, record) {
    const scope = tracer.scopeManager().active()

    record = record || {}

    if (scope) {
      const span = scope.span()

      record['dd.trace_id'] = span.context().toTraceId()
      record['dd.span_id'] = span.context().toSpanId()
    }

    return record
  }
}

module.exports = Object.assign({}, tx, log)
