const log = require('./log')
const format = require('./format')

class SpanProcessor {
  constructor (exporter, prioritySampler) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
  }

  // opentelemetry compat
  onStart () {}
  onEnd (span) {
    this.process(span)
  }
  // end open telemetry compat

  process (span) {
    const spanContext = span.context()
    const trace = spanContext._trace
    if (trace.started.length === trace.finished.length) {
      this._prioritySampler.sample(spanContext)

      if (spanContext._traceFlags.sampled === false) {
        log.debug(() => `Dropping trace due to user configured filtering: ${trace.started}`)
        this._erase(trace)
        return
      }

      this._exporter.export(trace.finished.map(format))
      this._erase(trace)
    }
  }

  _erase (trace) {
    trace.finished.forEach((span) => {
      span.context()._tags = {}
    })

    trace.started = []
    trace.finished = []
  }
}

module.exports = SpanProcessor
