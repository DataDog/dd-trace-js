const log = require('./log')

class SpanProcessor {
  constructor (exporter, prioritySampler) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
  }

  process (span) {
    const spanContext = span.context()
    const trace = spanContext._trace

    if (trace.started.length === trace.finished.length) {
      this._prioritySampler.sample(spanContext)

      if (spanContext._traceFlags.sampled === false) {
        log.debug(() => `Dropping trace due to user configured filtering: ${trace}`)
        this._erase(trace)
        return
      }
      this._exporter.export(span)
      this._erase(trace)
    }
  }

  _erase (trace) {
    trace.finished.forEach(span => {
      span.context()._tags = {}
      span.context()._metrics = {}
    })

    trace.started = []
    trace.finished = []
  }
}

module.exports = SpanProcessor
