const log = require('./log')
const format = require('./format')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

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
      const formattedSpans = trace.finished.map(format)
      this._exporter.export(formattedSpans)
      this._erase(trace)
    }
  }

  _erase (trace) {
    if (process.env.DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true') {
      const started = new Set()
      const startedIds = new Set()
      const finished = new Set()
      const finishedIds = new Set()

      for (const span of trace.finished) {
        const context = span.context()
        const id = context.toSpanId()

        if (finished.has(span)) {
          log.error(`Span was already finished in the same trace: ${span}`)
        } else {
          finished.add(span)

          if (finishedIds.has(id)) {
            log.error(`Another span with the same ID was already finished in the same trace: ${span}`)
          } else {
            finishedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error(`A span was finished in the wrong trace: ${span}.`)
          }

          if (finishedSpans.has(span)) {
            log.error(`Span was already finished in a different trace: ${span}`)
          } else {
            finishedSpans.add(span)
          }
        }
      }

      for (const span of trace.started) {
        const context = span.context()
        const id = context.toSpanId()

        if (started.has(span)) {
          log.error(`Span was already started in the same trace: ${span}`)
        } else {
          started.add(span)

          if (startedIds.has(id)) {
            log.error(`Another span with the same ID was already started in the same trace: ${span}`)
          } else {
            startedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error(`A span was started in the wrong trace: ${span}.`)
          }

          if (startedSpans.has(span)) {
            log.error(`Span was already started in a different trace: ${span}`)
          } else {
            startedSpans.add(span)
          }
        }

        if (!finished.has(span)) {
          log.error(`Span started in one trace but was finished in another trace: ${span}`)
        }
      }

      for (const span of trace.finished) {
        if (!started.has(span)) {
          log.error(`Span finished in one trace but was started in another trace: ${span}`)
        }
      }
    }

    for (const span of trace.finished) {
      span.context()._tags = {}
    }

    trace.started = []
    trace.finished = []
  }
}

module.exports = SpanProcessor
