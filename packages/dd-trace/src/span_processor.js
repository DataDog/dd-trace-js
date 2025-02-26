'use strict'

const log = require('./log')
const format = require('./format')
const SpanSampler = require('./span_sampler')
const { spanFilter } = require('./span_filter')
const GitMetadataTagger = require('./git_metadata_tagger')

const { SpanStatsProcessor } = require('./span_stats')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

const { channel } = require('dc-polyfill')
const spanProcessCh = channel('dd-trace:span:process')

class SpanProcessor {
  constructor (exporter, prioritySampler, config) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
    this._config = config
    this._killAll = false

    this._stats = new SpanStatsProcessor(config)
    this._spanSampler = new SpanSampler(config.sampler)
    this._gitMetadataTagger = new GitMetadataTagger(config)
  }

  process (span) {
    const spanContext = span.context()
    const active = []
    const formatted = []
    const trace = spanContext._trace
    const { flushMinSpans, tracing } = this._config
    const { started, finished } = trace

    if (trace.record === false) return
    if (tracing === false) {
      this._erase(trace, active)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this._prioritySampler.sample(spanContext)
      this._spanSampler.sample(spanContext)
      this._gitMetadataTagger.tagGitMetadata(spanContext)

      for (const currentSpan of started.slice()) { // Use a copy to avoid modification issues
        if (currentSpan._duration !== undefined) {
          if (spanFilter) {
            const tags = currentSpan.context()._tags

            // Check if the span has already been filtered
            if ('_dd.filtered' in tags) {
              // Span was previously filtered out, already removed from arrays
              // No need to process further
              continue
            } else {
              // Determine whether to keep or skip the span based on the filter
              if (!spanFilter.shouldKeepSpan(currentSpan.context())) {
              // Mark the span as filtered (skipped)
                tags['_dd.filtered'] = true

                // Remove the span from the 'started' array
                const startIndex = started.indexOf(currentSpan)
                if (startIndex !== -1) {
                  started.splice(startIndex, 1)
                }

                // Remove the span from the 'finished' array if it's already finished
                const finishIndex = finished.indexOf(currentSpan)
                if (finishIndex !== -1) {
                  finished.splice(finishIndex, 1)
                }

                // Remove all references to the span to allow garbage collection
                // This assumes there are no other references elsewhere in the code
                // In JavaScript, simply removing from arrays is typically sufficient
                // If there are other references, ensure they are also removed or set to null
                // Example (if applicable):
                // someOtherObject.span = null;

                // Continue to the next span
                continue
              } else {
              // Mark the span as not filtered (kept)
                tags['_dd.filtered'] = false
              }
            }
          }

          const formattedSpan = format(currentSpan)
          this._stats.onSpanFinished(formattedSpan)
          formatted.push(formattedSpan)

          spanProcessCh.publish({ span: currentSpan })
        } else {
          active.push(currentSpan)
        }
      }

      if (formatted.length !== 0 && trace.isRecording !== false) {
        this._exporter.export(formatted)
      }

      this._erase(trace, active)
    }

    if (this._killAll) {
      for (const startedSpan of started) {
        if (!startedSpan._finished) {
          startedSpan.finish()
        }
      }
    }
  }

  killAll () {
    this._killAll = true
  }

  _erase (trace, active) {
    if (process.env.DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true') {
      const started = new Set()
      const startedIds = new Set()
      const finished = new Set()
      const finishedIds = new Set()

      for (const span of trace.finished) {
        const context = span.context()
        const id = context.toSpanId()

        if (finished.has(span)) {
          log.error('Span was already finished in the same trace: %s', span)
        } else {
          finished.add(span)

          if (finishedIds.has(id)) {
            log.error('Another span with the same ID was already finished in the same trace: %s', span)
          } else {
            finishedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error('A span was finished in the wrong trace: %s', span)
          }

          if (finishedSpans.has(span)) {
            log.error('Span was already finished in a different trace: %s', span)
          } else {
            finishedSpans.add(span)
          }
        }
      }

      for (const span of trace.started) {
        const context = span.context()
        const id = context.toSpanId()

        if (started.has(span)) {
          log.error('Span was already started in the same trace: %s', span)
        } else {
          started.add(span)

          if (startedIds.has(id)) {
            log.error('Another span with the same ID was already started in the same trace: %s', span)
          } else {
            startedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error('A span was started in the wrong trace: %s', span)
          }

          if (startedSpans.has(span)) {
            log.error('Span was already started in a different trace: %s', span)
          } else {
            startedSpans.add(span)
          }
        }

        if (!finished.has(span)) {
          log.error('Span started in one trace but was finished in another trace: %s', span)
        }
      }

      for (const span of trace.finished) {
        if (!started.has(span)) {
          log.error('Span finished in one trace but was started in another trace: %s', span)
        }
      }
    }

    for (const span of trace.finished) {
      span.context()._tags = {}
    }

    trace.started = active
    trace.finished = []
  }
}

module.exports = SpanProcessor
